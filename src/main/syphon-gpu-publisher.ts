/**
 * Source-independent GPU publisher lifecycle.
 *
 * Both the synthetic first-gate canvas and the real offscreen audience use this
 * class. It owns the Electron OffscreenSharedTexture -> native IOSurface/Syphon
 * or DXGI/Spout path: one in-flight texture plus one replaceable latest frame,
 * async completion, release after completion, timeout hold, and software-paint
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
import { NativeGpuPublisher } from './syphon-gpu-native.js'
import { SyphonGpuMetrics } from './syphon-gpu-metrics.js'
import { GPU_PIXEL_BGRA, GPU_PIXEL_RGBA, GpuSendGate, sharedGpuHandle } from './syphon-gpu-core.js'

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
  /** Resolves after the mirrored import releases every reference to this frame. */
  consumeFrame?: (info: OffscreenSharedTexture['textureInfo']) => Promise<void>
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
  nativeCompletion: NonNullable<ReturnType<NativeGpuPublisher['poll']>> | null
  consumerDone: boolean
  consumerFailed: boolean
  consumerError: unknown
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

export interface GpuPublisherStopResult {
  /** The pending JS texture was released after native completion. */
  released: boolean
  /** Native completion did not arrive within the bound; one texture stays held. */
  timedOut: boolean
}

export class GpuTexturePublisher {
  private readonly gate = new GpuSendGate()
  private readonly metrics = new SyphonGpuMetrics()
  private readonly released = new WeakSet<object>()
  private readonly gateStartedAt = Date.now()
  private readonly onFirstTexture: (() => void) | undefined
  private native: NativeGpuPublisher | null = null
  private inFlight: InFlightTexture | null = null
  private latestTexture: OffscreenSharedTexture | null = null
  private nextFrameId = 0
  private pollTimer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private firstTextureTimer: NodeJS.Timeout | null = null
  private sawTexture = false
  private announcedFirstCompletion = false
  private missingTexturePaints = 0
  private firstTextureAtMs = 0
  private actualWidth = 0
  private actualHeight = 0
  private lastPaintDiagnostics: string | null = null
  private stuck = false
  private disposed = false
  private stopping = false
  private failed = false
  private stopPromise: Promise<GpuPublisherStopResult> | null = null
  private stopPollTimer: NodeJS.Timeout | null = null
  private stopDeadlineTimer: NodeJS.Timeout | null = null
  private readonly onProcessExit = (): void => {
    this.disposed = true
    this.native?.destroy()
    this.native = null
  }

  constructor(
    private readonly options: GpuPublisherOptions,
    private readonly source: () => GpuPaintSource | null,
    private readonly onFatal: (reason: string) => void,
    onFirstTexture?: () => void,
  ) {
    this.onFirstTexture = onFirstTexture
  }

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

  onPaint(event: Electron.Event<Electron.WebContentsPaintEventParams>, replay = false): void {
    const texture = event.texture
    // A paint can arrive after stop() began, including after the window was
    // destroyed. Release it immediately instead of retaining an unreachable
    // texture; the one already in flight is handled by native completion.
    if (this.disposed || this.stopping || this.failed || !this.native) {
      if (texture) this.releaseTexture(texture)
      return
    }
    const started = performance.now()
    if (!replay) this.metrics.inc('paints')
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
    if (!this.stuck && this.gate.isInFlight()) {
      // Keep the newest real GPU frame. Electron 44 may not deliver another GPU
      // capture after invalidate() when a static image finished loading while
      // the previous frame was busy. A one-slot queue preserves that last frame.
      if (this.latestTexture) this.releaseTexture(this.latestTexture)
      this.latestTexture = texture
      this.metrics.inc('droppedBusy')
      return
    }
    if (this.stuck || !this.gate.canSend()) {
      this.metrics.inc(this.gate.isReady() ? 'droppedBusy' : 'droppedNotReady')
      this.releaseTexture(texture)
      return
    }
    const info = texture.textureInfo
    const sharedHandle = sharedGpuHandle(info, process.platform)
    if (info.widgetType !== 'frame' || !sharedHandle) {
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
    const stride = this.native.surfaceStride(sharedHandle, info.codedSize.width)
    if (!pixelFormat || !stride) {
      this.metrics.inc('invalidTexture')
      this.releaseTexture(texture)
      return
    }
    const firstTexture = !this.sawTexture
    if (firstTexture) {
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
      sharedHandle, info.codedSize.width, info.codedSize.height,
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
    const flight: InFlightTexture = {
      texture, frameId, sentAt: performance.now(), nativeCompletion: null,
      consumerDone: !this.options.consumeFrame, consumerFailed: false, consumerError: null,
    }
    this.inFlight = flight
    this.metrics.inc('submitted')
    this.actualWidth = info.codedSize.width
    this.actualHeight = info.codedSize.height
    this.metrics.setSize(info.codedSize.width, info.codedSize.height)
    this.metrics.recordCallback(performance.now() - started)
    this.startPolling()
    this.watchdog = setTimeout(() => {
      if (!this.inFlight) return
      // Either consumer may still own the source: keep one bounded texture.
      this.metrics.inc('timeouts')
      this.stuck = true
      this.failed = true
      log.warn('syphon-gpu: native/mirror completion timeout; holding one JS texture, no new frames')
      this.onFatal('native/mirror completion timeout; source texture is retained')
    }, this.options.timeoutMs)
    this.watchdog.unref?.()
    if (this.options.consumeFrame) {
      try {
        this.options.consumeFrame(info).then(
          () => this.settleConsumer(flight, false, null),
          (error) => this.settleConsumer(flight, true, error),
        )
      } catch (error) {
        this.settleConsumer(flight, true, error)
      }
    }
  }

  destroyNow(): void {
    if (this.disposed || this.stopping) return
    this.disposed = true
    process.removeListener('exit', this.onProcessExit)
    this.clearTimers()
    this.releaseLatestTexture()
    if (this.inFlight && this.pollStopCompletion()) {
      // completion was available; release was performed by pollCompletion
    }
    if (this.inFlight) {
      retiredPublishers.add(this)
      log.warn('syphon-gpu: dispose while native/mirror frame is pending; JS texture held')
    }
    this.gate.markDead()
    this.native?.destroy()
    this.native = null
    this.metrics.stop()
    log.info('syphon-gpu: publisher stopped')
  }

  /**
   * Stop and wait for the one in-flight frame, bounded by `timeoutMs`.
   *
   * The window/ghost is already gone by the time this is called; only the JS
   * OffscreenSharedTexture remains. Keeping the native publisher alive until
   * poll() reports completion is what makes repeated off/on safe: the texture
   * is released instead of being parked in retiredPublishers forever.
   *
   * If completion never arrives within the bound, exactly one texture is held
   * until app exit and the caller receives `timedOut`. The caller must not start
   * another publisher after that (SyphonGpuManager locks restarts) — otherwise
   * every restart would add another permanently held texture.
   */
  stopAndWait(timeoutMs = this.options.timeoutMs): Promise<GpuPublisherStopResult> {
    if (this.stopPromise) return this.stopPromise
    if (this.disposed) return Promise.resolve({ released: true, timedOut: false })
    this.stopping = true
    process.removeListener('exit', this.onProcessExit)
    this.clearTimers()
    this.releaseLatestTexture()
    this.stopPromise = new Promise<GpuPublisherStopResult>((resolve) => {
      let finished = false
      const finish = (timedOut: boolean): void => {
        if (finished) return
        finished = true
        this.clearStopTimers()
        if (timedOut && this.inFlight) {
          retiredPublishers.add(this)
          log.warn('syphon-gpu: stop timed out with a native/mirror frame pending; ' +
            'one JS texture held until app exit, restarts must stay blocked')
        }
        this.disposed = true
        this.gate.markDead()
        this.native?.destroy()
        this.native = null
        this.metrics.stop()
        log.info(`syphon-gpu: publisher stopped${timedOut ? ' (completion timeout)' : ''}`)
        resolve({ released: !timedOut, timedOut })
      }
      let closing = false
      const pollStop = (): boolean => {
        if (this.inFlight && !this.pollStopCompletion()) return false
        if (!closing) {
          this.native?.requestClose()
          closing = true
        }
        // Windows must withdraw the old Spout source before another sender can
        // claim its name. Native cleanup runs on the worker, never blocks JS.
        if (this.native && !this.native.isClosed()) return false
        finish(false)
        return true
      }
      if (pollStop()) return
      this.stopPollTimer = setInterval(() => { pollStop() }, POLL_MS)
      this.stopPollTimer.unref?.()
      this.stopDeadlineTimer = setTimeout(() => finish(true), Math.max(100, timeoutMs))
      this.stopDeadlineTimer.unref?.()
    })
    return this.stopPromise
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

  /** Returns true only after native and mirror both finish. */
  private pollCompletion(): boolean {
    if (!this.inFlight) return false
    if (!this.captureNativeCompletion(false)) return false
    if (!this.inFlight.consumerDone) return false
    const completion = this.inFlight.nativeCompletion!
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    const sentAt = this.inFlight.sentAt
    const consumerFailed = this.inFlight.consumerFailed
    const consumerError = this.inFlight.consumerError
    this.releaseInFlight()
    this.gate.ack()
    if (completion.status === 0 && !consumerFailed) {
      this.metrics.inc('published')
      this.metrics.recordAck(performance.now() - sentAt)
      if (!this.announcedFirstCompletion) {
        this.announcedFirstCompletion = true
        this.onFirstTexture?.()
      }
    }
    if (completion.status !== 0 || consumerFailed) {
      this.metrics.inc('errors')
      this.gate.markDead()
      this.fail(consumerFailed
        ? `GPU mirror consumer: ${String(consumerError instanceof Error ? consumerError.message : consumerError)}`
        : `native GPU status ${completion.status}, detail 0x${completion.detail.toString(16).padStart(8, '0')}`)
      return true
    }
    const latest = this.latestTexture
    this.latestTexture = null
    if (latest) this.onPaint({ texture: latest } as Electron.Event<Electron.WebContentsPaintEventParams>, true)
    if (!this.inFlight) {
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    return true
  }

  private clearStopTimers(): void {
    if (this.stopPollTimer) clearInterval(this.stopPollTimer)
    if (this.stopDeadlineTimer) clearTimeout(this.stopDeadlineTimer)
    this.stopPollTimer = this.stopDeadlineTimer = null
  }

  /** Completion during stop: release after both consumers, but never call onFatal. */
  private pollStopCompletion(): boolean {
    if (!this.inFlight || !this.captureNativeCompletion(true) || !this.inFlight.consumerDone) return false
    const completion = this.inFlight.nativeCompletion!
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    const sentAt = this.inFlight.sentAt
    this.releaseInFlight()
    this.gate.ack()
    if (completion.status === 0) {
      this.metrics.inc('published')
      this.metrics.recordAck(performance.now() - sentAt)
    } else {
      this.metrics.inc('errors')
    }
    return true
  }

  private captureNativeCompletion(stopping: boolean): boolean {
    if (!this.inFlight) return false
    if (this.inFlight.nativeCompletion) return true
    if (!this.native) return false
    const completion = this.native.poll()
    if (!completion) return false
    if (completion.frameId !== this.inFlight.frameId) {
      log.warn(`syphon-gpu: stale native completion${stopping ? ' during stop' : ''} ${completion.frameId}`)
      return false
    }
    this.inFlight.nativeCompletion = completion
    return true
  }

  private settleConsumer(flight: InFlightTexture, failed: boolean, error: unknown): void {
    flight.consumerDone = true
    flight.consumerFailed = failed
    flight.consumerError = error
    if (this.inFlight !== flight) return
    if (this.disposed) {
      // destroyNow can retire a frame after native ACK but before mirror ACK.
      if (flight.nativeCompletion) {
        this.releaseInFlight()
        retiredPublishers.delete(this)
      }
    } else if (!this.stopping) {
      this.pollCompletion()
    }
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

  private releaseLatestTexture(): void {
    if (this.latestTexture) this.releaseTexture(this.latestTexture)
    this.latestTexture = null
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    this.releaseLatestTexture()
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
    this.native?.destroy()
    this.native = null
    this.metrics.stop()
    this.onFatal(reason)
  }
}
