/**
 * Source-independent GPU publisher lifecycle.
 *
 * Both the synthetic first-gate canvas and the real offscreen audience use this
 * class. It owns only the Electron OffscreenSharedTexture -> native non-global
 * IOSurface -> Syphon path, one in-flight texture, async completion polling,
 * texture release after completion, timeout hold, and first-software-paint
 * handling. It never reads bitmap/NativeImage pixels and never creates a
 * renderer.
 *
 * Electron 33.4.11 can emit a software-composited paint with no texture before
 * the GPU capturer produces a frame. That paint is counted and skipped; a real
 * valid texture must arrive within firstTextureMs or the owner gets onFatal.
 */
import { app, type OffscreenSharedTexture, type WebContents } from 'electron'
import log from 'electron-log/main'
import { performance } from 'node:perf_hooks'
import { LatestFrameRecovery } from './syphon-bridge-core.js'
import { NativeGpuPublisher } from './syphon-gpu-native.js'
import { SyphonGpuMetrics } from './syphon-gpu-metrics.js'
import { GPU_PIXEL_BGRA, GPU_PIXEL_RGBA, GpuSendGate } from './syphon-gpu-core.js'

const POLL_MS = 4

// A stopped publisher with a native frame still in flight must stay referenced:
// the JS OffscreenSharedTexture cannot be GC/released until GPU completion.
// These are intentionally process-lifetime holds (bounded one per stop).
const retiredPublishers = new Set<GpuTexturePublisher>()

export function retiredGpuPublisherCount(): number { return retiredPublishers.size }

export interface GpuPublisherOptions {
  nativePath: string
  name: string
  isPublic: boolean
  flipY: boolean
  timeoutMs: number
  firstTextureMs: number
  /** Required physical texture size; a mismatch is an explicit failure. */
  targetSize?: { width: number; height: number }
}

export interface GpuPaintSource {
  webContents: WebContents
  isDestroyed(): boolean
  invalidate(): void
}

interface InFlightTexture {
  texture: OffscreenSharedTexture
  frameId: number
  sentAt: number
}

export interface GpuPublisherStatus {
  failed: boolean
  disposed: boolean
  sawTexture: boolean
  missingTexturePaints: number
  inFlight: boolean
  firstTextureAtMs: number
  width: number
  height: number
}

export class GpuTexturePublisher {
  private readonly gate = new GpuSendGate()
  private readonly recovery = new LatestFrameRecovery()
  private readonly metrics = new SyphonGpuMetrics()
  private readonly released = new WeakSet<object>()
  private readonly gateStartedAt = Date.now()
  private native: NativeGpuPublisher | null = null
  private inFlight: InFlightTexture | null = null
  private nextFrameId = 0
  private pollTimer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private firstTextureTimer: NodeJS.Timeout | null = null
  private sawTexture = false
  private missingTexturePaints = 0
  private firstTextureAtMs = 0
  private actualWidth = 0
  private actualHeight = 0
  private lastPaintDiagnostics: string | null = null
  private stuck = false
  private disposed = false
  private failed = false
  private readonly onProcessExit = (): void => {
    this.disposed = true
    this.native?.destroy()
    this.native = null
  }

  constructor(
    private readonly options: GpuPublisherOptions,
    private readonly source: () => GpuPaintSource | null,
    private readonly onFatal: (reason: string) => void,
  ) {}

  start(): void {
    if (this.disposed) return
    process.once('exit', this.onProcessExit)
    this.metrics.start()
    if (this.options.targetSize) {
      this.metrics.setTargetSize(this.options.targetSize.width, this.options.targetSize.height)
    }
    try {
      this.native = NativeGpuPublisher.load(
        this.options.nativePath, this.options.name, !this.options.isPublic, this.options.flipY)
      this.gate.markReady()
    } catch (error) {
      this.fail(`native GPU publisher: ${(error as Error).message}`)
      return
    }
    this.armFirstTextureDeadline()
    log.info(
      `syphon-gpu: in-process C ABI, server=${this.options.isPublic ? 'PUBLIC' : 'private'}, ` +
      `flipY=${this.options.flipY ? 1 : 0}, target=${this.options.targetSize
        ? `${this.options.targetSize.width}x${this.options.targetSize.height}` : 'none'}`,
    )
    log.info(`syphon-gpu: environment ${JSON.stringify(this.environmentDiagnostics())}`)
  }

  onPaint(event: Electron.Event<Electron.WebContentsPaintEventParams>): void {
    if (this.disposed || this.failed || !this.native) return
    const started = performance.now()
    this.metrics.inc('paints')
    const texture = event.texture
    if (!texture) {
      // See osr_host_display_client.cc LayeredWindowUpdater::Draw: software
      // compositor emits callback(damage, bitmap, {}) before/without GPU capture.
      // Never touch the bitmap or fall back to CPU.
      this.missingTexturePaints++
      this.metrics.inc('missingTexturePaints')
      this.armFirstTextureDeadline()
      this.lastPaintDiagnostics = JSON.stringify(this.paintDiagnostics(event))
      if (this.missingTexturePaints <= 3 || this.missingTexturePaints % 30 === 0) {
        log.warn(`syphon-gpu: paint without texture (transient software frame?) ${this.lastPaintDiagnostics}`)
      }
      return
    }
    if (this.stuck || !this.gate.canSend()) {
      if (this.gate.isInFlight()) this.recovery.skippedWhileBusy()
      this.metrics.inc(this.gate.isReady() ? 'droppedBusy' : 'droppedNotReady')
      this.releaseTexture(texture)
      return
    }
    const info = texture.textureInfo
    if (info.widgetType !== 'frame' || !info.sharedTextureHandle) {
      this.metrics.inc('invalidTexture')
      this.releaseTexture(texture)
      return
    }
    const target = this.options.targetSize
    if (target && (info.codedSize.width !== target.width || info.codedSize.height !== target.height)) {
      this.metrics.inc('invalidTexture')
      this.releaseTexture(texture)
      this.fail(`physical texture size ${info.codedSize.width}x${info.codedSize.height} ` +
        `does not match target ${target.width}x${target.height}`)
      return
    }
    const pixelFormat = info.pixelFormat === 'bgra' ? GPU_PIXEL_BGRA
      : info.pixelFormat === 'rgba' ? GPU_PIXEL_RGBA : 0
    const stride = this.native.surfaceStride(info.sharedTextureHandle)
    if (!pixelFormat || !stride) {
      this.metrics.inc('invalidTexture')
      this.releaseTexture(texture)
      return
    }
    if (!this.sawTexture) {
      this.sawTexture = true
      this.firstTextureAtMs = Date.now() - this.gateStartedAt
      this.clearFirstTextureDeadline()
      this.metrics.markFirstTexture(this.firstTextureAtMs)
      log.info(`syphon-gpu: first valid texture after ${this.firstTextureAtMs}ms ` +
        `${info.codedSize.width}x${info.codedSize.height}`)
    }
    const frameId = ++this.nextFrameId
    const submitStart = performance.now()
    const result = this.native.submit(
      info.sharedTextureHandle, info.codedSize.width, info.codedSize.height,
      stride, pixelFormat, frameId,
    )
    this.metrics.recordSubmit(performance.now() - submitStart)
    if (!result.ok) {
      this.metrics.inc('errors')
      this.releaseTexture(texture)
      log.warn(`syphon-gpu: submit rejected: ${result.error}`)
      this.fail(`native submit: ${result.error}`)
      return
    }
    this.gate.begin()
    this.recovery.begin()
    this.inFlight = { texture, frameId, sentAt: performance.now() }
    this.metrics.inc('submitted')
    this.actualWidth = info.codedSize.width
    this.actualHeight = info.codedSize.height
    this.metrics.setSize(info.codedSize.width, info.codedSize.height)
    this.metrics.recordCallback(performance.now() - started)
    this.startPolling()
    this.watchdog = setTimeout(() => {
      if (!this.inFlight) return
      // No completion evidence: keep one bounded texture and stop new frames.
      this.metrics.inc('timeouts')
      this.stuck = true
      log.warn('syphon-gpu: async completion timeout; holding one JS texture, no new frames')
    }, this.options.timeoutMs)
    this.watchdog.unref?.()
  }

  destroyNow(): void {
    if (this.disposed) return
    this.disposed = true
    process.removeListener('exit', this.onProcessExit)
    this.clearTimers()
    if (this.inFlight && this.pollCompletion()) {
      // completion was available; release was performed by pollCompletion
    }
    if (this.inFlight) {
      retiredPublishers.add(this)
      log.warn('syphon-gpu: dispose while native frame is still pending; JS texture held until app exit')
    }
    this.gate.markDead()
    this.recovery.reset()
    this.native?.destroy()
    this.native = null
    this.metrics.stop()
    log.info('syphon-gpu: publisher stopped')
  }

  status(): GpuPublisherStatus {
    return {
      failed: this.failed,
      disposed: this.disposed,
      sawTexture: this.sawTexture,
      missingTexturePaints: this.missingTexturePaints,
      inFlight: this.inFlight !== null,
      firstTextureAtMs: this.firstTextureAtMs,
      width: this.actualWidth,
      height: this.actualHeight,
    }
  }

  private clearTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.watchdog) clearTimeout(this.watchdog)
    if (this.firstTextureTimer) clearTimeout(this.firstTextureTimer)
    this.pollTimer = this.watchdog = this.firstTextureTimer = null
  }

  private armFirstTextureDeadline(): void {
    if (this.firstTextureTimer || this.sawTexture || this.disposed || this.failed) return
    this.firstTextureTimer = setTimeout(() => {
      this.firstTextureTimer = null
      if (this.sawTexture || this.disposed || this.failed) return
      const detail = this.lastPaintDiagnostics ?? JSON.stringify(this.environmentDiagnostics())
      this.fail(`no valid GPU texture within ${this.options.firstTextureMs}ms ` +
        `(missingTexturePaints=${this.missingTexturePaints}); ${detail}`)
    }, this.options.firstTextureMs)
    this.firstTextureTimer.unref?.()
  }

  private clearFirstTextureDeadline(): void {
    if (this.firstTextureTimer) clearTimeout(this.firstTextureTimer)
    this.firstTextureTimer = null
  }

  private environmentDiagnostics(): Record<string, unknown> {
    const wc = this.source()?.webContents as unknown as {
      isOffscreen?: () => boolean
      isPainting?: () => boolean
      getType?: () => string
      getLastWebPreferences?: () => unknown
    } | undefined
    let preferences: unknown = 'unavailable'
    try { preferences = wc?.getLastWebPreferences?.() ?? 'unavailable' } catch (error) {
      preferences = `error: ${(error as Error).message}`
    }
    const safePreferences = preferences && typeof preferences === 'object'
      ? {
          offscreen: (preferences as Record<string, unknown>).offscreen,
          sandbox: (preferences as Record<string, unknown>).sandbox,
          contextIsolation: (preferences as Record<string, unknown>).contextIsolation,
          backgroundThrottling: (preferences as Record<string, unknown>).backgroundThrottling,
          nodeIntegration: (preferences as Record<string, unknown>).nodeIntegration,
          webSecurity: (preferences as Record<string, unknown>).webSecurity,
        }
      : preferences
    let gpu: Record<string, unknown> | string = 'unavailable'
    try {
      const status = app.getGPUFeatureStatus() as unknown as Record<string, unknown>
      gpu = {
        gpu_compositing: status.gpu_compositing,
        webgl: status.webgl,
        rasterization: status.rasterization,
        multiple_raster_threads: status.multiple_raster_threads,
      }
    } catch (error) {
      gpu = `error: ${(error as Error).message}`
    }
    return {
      isOffscreen: wc?.isOffscreen?.(),
      isPainting: wc?.isPainting?.(),
      type: wc?.getType?.(),
      lastWebPreferences: safePreferences,
      gpuFeatureStatus: gpu,
    }
  }

  private paintDiagnostics(event: Electron.Event<Electron.WebContentsPaintEventParams>): Record<string, unknown> {
    return {
      elapsedMs: Date.now() - this.gateStartedAt,
      missingTexturePaints: this.missingTexturePaints,
      hasTextureProperty: Object.prototype.hasOwnProperty.call(event, 'texture'),
      textureValue: event.texture === null ? 'null' : typeof event.texture,
      eventKeys: Object.keys(event),
      ...this.environmentDiagnostics(),
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => this.pollCompletion(), POLL_MS)
    this.pollTimer.unref?.()
  }

  /** Returns true if a completion was consumed. */
  private pollCompletion(): boolean {
    if (!this.native || !this.inFlight) return false
    const completion = this.native.poll()
    if (!completion) return false
    if (completion.frameId !== this.inFlight.frameId) {
      log.warn(`syphon-gpu: stale native completion ${completion.frameId}`)
      return false
    }
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    const sentAt = this.inFlight.sentAt
    this.releaseInFlight()
    this.gate.ack()
    if (completion.status === 0) {
      this.metrics.inc('published')
      this.metrics.recordAck(performance.now() - sentAt)
    }
    if (completion.status !== 0) {
      this.metrics.inc('errors')
      this.recovery.reset()
      this.gate.markDead()
      this.fail(`native GPU status ${completion.status}`)
      return true
    }
    const src = this.source()
    if (this.recovery.published() && src && !src.isDestroyed()) src.invalidate()
    if (!this.inFlight) {
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    return true
  }

  private releaseTexture(texture: OffscreenSharedTexture): void {
    if (this.released.has(texture as unknown as object)) return
    this.released.add(texture as unknown as object)
    try { texture.release() } catch { /* already gone */ }
    this.metrics.inc('released')
  }

  private releaseInFlight(): void {
    if (!this.inFlight) return
    const texture = this.inFlight.texture
    this.inFlight = null
    this.releaseTexture(texture)
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    this.metrics.inc('errors')
    log.error(`syphon-gpu: disabled: ${reason}`)
    this.clearTimers()
    if (!this.inFlight || this.pollCompletion()) {
      // no pending texture, or completion released it
    } else {
      retiredPublishers.add(this)
      log.warn('syphon-gpu: fail with pending native frame; JS texture held until app exit')
    }
    this.gate.markDead()
    this.recovery.reset()
    this.native?.destroy()
    this.native = null
    this.metrics.stop()
    this.onFatal(reason)
  }
}
