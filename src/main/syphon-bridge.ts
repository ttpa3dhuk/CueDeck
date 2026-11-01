/**
 * Dev-only CPU fallback bridge: final CueDeck audience frame (NativeImage) ->
 * bounded binary pipe -> separate native helper -> Syphon Metal server.
 *
 * This is NOT zero-copy. It is enabled only by CUEDECK_SYPHON_BRIDGE=1 in an
 * unpackaged app. Packaging ignores the switch entirely. A public Syphon source
 * needs the additional explicit CUEDECK_SYPHON_BRIDGE_PUBLIC=1; otherwise the
 * helper serves a private server that only the local selftest/client can see.
 *
 * The audience window is the source of truth: its subscription captures the
 * final composited frame (slide, video, key visual, blackout, Fade) instead of
 * decoding or rendering any source a second time.
 */
import { app, BrowserWindow, screen, type NativeImage } from 'electron'
import log from 'electron-log/main'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { acquireFrameTap, type FrameTapLease } from './frame-tap.js'
import {
  ACK_HEADER_BYTES,
  FrameSendGate,
  MAX_FRAME_HEIGHT,
  MAX_FRAME_WIDTH,
  STATUS_BAD_FRAME,
  STATUS_GPU_TIMEOUT,
  STATUS_INTERNAL,
  STATUS_PROTOCOL_ERROR,
  STATUS_PUBLISHED,
  STATUS_READY,
  decodeAck,
  encodeFrameHeader,
  type AckHeader,
} from './syphon-bridge-protocol.js'
import { SyphonBridgeMetrics } from './syphon-bridge-metrics.js'
import { LatestFrameRecovery, RestartBudget } from './syphon-bridge-core.js'
import { acquireGhost, createHiddenAudienceWindow, getActiveWindows, releaseGhost } from './windows.js'

const HOLDER = 'syphon-bridge'
const HELPER_NAME = 'CueDeck Syphon Bridge'
const DEFAULT_GHOST_WIDTH = 1920
const DEFAULT_GHOST_HEIGHT = 1080
const MAX_RESTARTS = 4
const STARTUP_TIMEOUT_MS = 3000
const STABLE_RESET_MS = 10000

interface BridgeConfig {
  helperPath: string
  name: string
  isPublic: boolean
  flipY: boolean
  origin: 'top-left' | 'bottom-left'
  helperTimeoutMs: number
}

interface HelperCallbacks {
  onAck(ack: AckHeader): void
  onExit(code: number | null, signal: NodeJS.Signals | null, detail: string): void
}

class HelperProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private stdoutBuffer = Buffer.alloc(0)
  private stderrBuffer = ''
  private finished = false
  private killTimer: NodeJS.Timeout | null = null

  constructor(path: string, args: string[], private readonly callbacks: HelperCallbacks) {
    this.child = spawn(path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    this.child.on('error', (error) => this.finish(null, null, `spawn: ${error.message}`))
    this.child.on('exit', (code, signal) => this.finish(code, signal, 'exit'))
    this.child.stdin.on('error', (error) => {
      log.warn(`syphon-bridge: helper stdin error: ${error.message}`)
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  writeFrame(header: Buffer, payload: Buffer): boolean {
    if (this.finished || this.child.stdin.destroyed || !this.child.stdin.writable) return false
    try {
      this.child.stdin.write(header)
      this.child.stdin.write(payload)
      return true
    } catch (error) {
      log.warn(`syphon-bridge: helper write failed: ${(error as Error).message}`)
      return false
    }
  }

  kill(reason: string): void {
    if (this.finished) return
    log.warn(`syphon-bridge: stopping helper (${reason})`)
    try { this.child.stdin.end() } catch { /* already closed */ }
    try { this.child.kill('SIGTERM') } catch { /* already exited */ }
    this.killTimer = setTimeout(() => {
      if (!this.finished) {
        try { this.child.kill('SIGKILL') } catch { /* already exited */ }
      }
    }, 500)
    this.killTimer.unref?.()
  }

  destroyNow(): void {
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = null
    this.finished = true
    try { this.child.stdin.end() } catch { /* already closed */ }
    try { this.child.kill('SIGKILL') } catch { /* already exited */ }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, detail: string): void {
    if (this.finished) return
    this.finished = true
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = null
    this.callbacks.onExit(code, signal, detail)
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    while (this.stdoutBuffer.length >= ACK_HEADER_BYTES) {
      const bytes = this.stdoutBuffer.subarray(0, ACK_HEADER_BYTES)
      this.stdoutBuffer = this.stdoutBuffer.subarray(ACK_HEADER_BYTES)
      try {
        this.callbacks.onAck(decodeAck(bytes))
      } catch (error) {
        log.warn(`syphon-bridge: invalid helper ack: ${(error as Error).message}`)
        this.kill('invalid ack')
        return
      }
    }
    if (this.stdoutBuffer.length > ACK_HEADER_BYTES * 4) {
      log.warn('syphon-bridge: helper stdout overflow')
      this.kill('stdout overflow')
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8')
    const lines = this.stderrBuffer.split(/\r?\n/)
    this.stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) log.warn(`syphon-bridge helper: ${line}`)
    }
    if (this.stderrBuffer.length > 4096) this.stderrBuffer = this.stderrBuffer.slice(-4096)
  }
}

function envFlag(name: string): boolean {
  return process.env[name] === '1'
}

function cleanName(value: string | undefined): string {
  const name = (value ?? '').trim()
  if (!name) return HELPER_NAME
  return name.slice(0, 128)
}

function helperPath(): string {
  const configured = process.env.CUEDECK_SYPHON_BRIDGE_HELPER
  if (configured) return isAbsolute(configured) ? configured : resolve(app.getAppPath(), configured)
  return join(app.getAppPath(), 'native', 'syphon-probe', 'build', 'CueDeckSyphonHelper')
}

function numericEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

export class SyphonBridge {
  private readonly metrics = new SyphonBridgeMetrics()
  private readonly gate = new FrameSendGate()
  private readonly recovery = new LatestFrameRecovery()
  private readonly config: BridgeConfig
  private disposed = false
  private failed = false
  private followTimer: NodeJS.Timeout | null = null
  private win: BrowserWindow | null = null
  private tap: FrameTapLease | null = null
  private helper: HelperProcess | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private inFlightId = 0
  private nextFrameId = 0
  private lastSentAt = 0
  private trackCallback = false
  private readonly restartBudget = new RestartBudget(MAX_RESTARTS)
  private readonly onProcessExit = (): void => {
    // process 'exit' cannot do async work; kill the child and leave window
    // teardown to Electron. This is the path that keeps quit from hanging.
    this.disposed = true
    this.helper?.destroyNow()
    this.helper = null
  }

  constructor() {
    const timeout = numericEnv('CUEDECK_SYPHON_BRIDGE_TIMEOUT_MS', 2000, 250, 5000)
    this.config = {
      helperPath: helperPath(),
      name: cleanName(process.env.CUEDECK_SYPHON_BRIDGE_NAME),
      isPublic: envFlag('CUEDECK_SYPHON_BRIDGE_PUBLIC'),
      flipY: envFlag('CUEDECK_SYPHON_BRIDGE_FLIP_Y'),
      origin: process.env.CUEDECK_SYPHON_BRIDGE_ORIGIN === 'bottom-left' ? 'bottom-left' : 'top-left',
      helperTimeoutMs: timeout,
    }
  }

  start(): void {
    if (this.disposed) return
    process.once('exit', this.onProcessExit)
    this.metrics.start()
    log.info(
      `syphon-bridge: dev opt-in, helper=${this.config.helperPath}, ` +
      `server=${this.config.isPublic ? 'PUBLIC' : 'private'}, flipY=${this.config.flipY ? 1 : 0}`,
    )
    this.follow()
    this.followTimer = setInterval(() => this.follow(), 500)
    this.followTimer.unref?.()
    this.spawnHelper()
  }

  destroyNow(): void {
    if (this.disposed) return
    this.disposed = true
    process.removeListener('exit', this.onProcessExit)
    if (this.followTimer) clearInterval(this.followTimer)
    this.followTimer = null
    this.clearTimers()
    this.detachTap()
    releaseGhost('audience', HOLDER)
    this.helper?.destroyNow()
    this.helper = null
    this.gate.markDead()
    this.recovery.reset()
    this.metrics.stop()
    log.info('syphon-bridge: stopped')
  }

  private clearTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.watchdog) clearTimeout(this.watchdog)
    this.startupTimer = this.stableTimer = this.restartTimer = this.watchdog = null
  }

  private detachTap(): void {
    this.tap?.release()
    this.tap = null
    this.win = null
  }

  private follow(): void {
    if (this.disposed || this.failed) return
    const real = getActiveWindows().get('audience')
    let target: BrowserWindow
    if (real && !real.isDestroyed()) {
      releaseGhost('audience', HOLDER)
      target = real
    } else {
      const sf = screen.getPrimaryDisplay().scaleFactor || 1
      target = acquireGhost('audience', HOLDER, () => createHiddenAudienceWindow(
        Math.max(320, Math.round(DEFAULT_GHOST_WIDTH / sf)),
        Math.max(180, Math.round(DEFAULT_GHOST_HEIGHT / sf)),
      ))
    }
    if (target === this.win && this.tap) return

    this.detachTap()
    this.win = target
    try {
      this.tap = acquireFrameTap(target.webContents, HOLDER, (image) => this.onFrame(image))
    } catch (error) {
      log.warn(`syphon-bridge: cannot acquire audience frame tap: ${(error as Error).message}`)
      this.win = null
      return
    }
    this.kick(target)
    log.info(`syphon-bridge: capturing audience window \"${target.getTitle()}\"`)
  }

  private kick(target: BrowserWindow): void {
    const wc = target.webContents
    const kick = (): void => {
      if (!this.disposed && !target.isDestroyed() && target === this.win) wc.invalidate()
    }
    if (wc.isLoading()) {
      wc.once('did-finish-load', () => {
        const timer = setTimeout(kick, 300)
        timer.unref?.()
      })
    } else {
      kick()
    }
  }

  private drop(noHelper: boolean): void {
    if (noHelper) this.metrics.inc('droppedNoHelper')
    else this.metrics.inc('droppedBusy')
  }

  private onFrame(image: NativeImage): void {
    const callbackStart = performance.now()
    this.metrics.inc('captured')
    this.trackCallback = false
    try {
      this.handleFrame(image)
    } finally {
      if (this.trackCallback) this.metrics.recordCallback(performance.now() - callbackStart)
    }
  }

  private handleFrame(image: NativeImage): void {
    if (this.disposed || this.failed) return
    if (!this.helper || !this.gate.canSend()) {
      if (this.gate.isInFlight()) this.recovery.skippedWhileBusy()
      this.drop(!this.gate.isReady())
      return
    }
    if (image.isEmpty()) {
      this.metrics.inc('invalidFrame')
      return
    }

    let frame = image
    let size = frame.getSize()
    if (size.width < 16 || size.height < 16) {
      this.metrics.inc('invalidFrame')
      return
    }
    if (size.width > MAX_FRAME_WIDTH || size.height > MAX_FRAME_HEIGHT) {
      const scale = Math.min(MAX_FRAME_WIDTH / size.width, MAX_FRAME_HEIGHT / size.height)
      const width = Math.max(16, Math.floor(size.width * scale))
      const height = Math.max(16, Math.floor(size.height * scale))
      const resizeStart = performance.now()
      try {
        frame = frame.resize({ width, height, quality: 'good' })
      } catch (error) {
        log.warn(`syphon-bridge: resize failed: ${(error as Error).message}`)
        this.metrics.inc('invalidFrame')
        return
      }
      this.metrics.recordResize(performance.now() - resizeStart)
      size = frame.getSize()
    }
    const width = size.width
    const height = size.height
    const stride = width * 4
    if (width < 16 || height < 16 || stride > MAX_FRAME_WIDTH * 4) {
      this.metrics.inc('invalidFrame')
      return
    }

    const readbackStart = performance.now()
    let bitmap: Buffer
    try {
      bitmap = frame.toBitmap()
    } catch (error) {
      log.warn(`syphon-bridge: NativeImage.toBitmap failed: ${(error as Error).message}`)
      this.metrics.inc('invalidFrame')
      return
    }
    const readbackMs = performance.now() - readbackStart
    if (bitmap.length !== stride * height) {
      log.warn(`syphon-bridge: bitmap length ${bitmap.length} != ${stride * height}`)
      this.metrics.inc('invalidFrame')
      return
    }
    if (!this.gate.begin()) {
      this.drop(!this.gate.isReady())
      return
    }
    this.trackCallback = true

    // NativeImage's SkBitmap is declared top-left here. This is the bridge
    // input contract; if Electron's representation changes, the helper would
    // need a bottom-left flag and the frame would be rejected rather than
    // silently rotated. The Y-flip for a recipient is a separate helper flag.
    const frameId = ++this.nextFrameId
    this.inFlightId = frameId
    let header: Buffer
    try {
      header = encodeFrameHeader({
        width, height, stride, payloadLength: bitmap.length, frameId,
        premultiplied: true,
        origin: this.config.origin,
      })
    } catch (error) {
      log.warn(`syphon-bridge: refusing frame: ${(error as Error).message}`)
      this.gate.timeout()
      this.metrics.inc('invalidFrame')
      return
    }
    if (!this.helper.writeFrame(header, bitmap)) {
      this.gate.markDead()
      this.recovery.reset()
      this.metrics.inc('writeErrors')
      this.helper.kill('write failed')
      return
    }

    this.lastSentAt = performance.now()
    this.recovery.begin()
    this.metrics.recordReadback(readbackMs)
    this.metrics.setSize(width, height)
    this.metrics.inc('sent')
    const timeoutMs = this.config.helperTimeoutMs + 750
    this.watchdog = setTimeout(() => {
      if (this.inFlightId !== frameId) return
      this.metrics.inc('timeouts')
      this.gate.markDead()
      this.recovery.reset()
      this.inFlightId = 0
      this.helper?.kill('ack watchdog')
    }, timeoutMs)
    this.watchdog.unref?.()
  }

  private spawnHelper(): void {
    if (this.disposed || this.failed) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (!existsSync(this.config.helperPath)) {
      log.warn(`syphon-bridge: helper not found: ${this.config.helperPath}`)
      this.fail('helper binary missing')
      return
    }
    const args = [
      'serve',
      '--name', this.config.name,
      '--timeout-ms', String(this.config.helperTimeoutMs),
      '--flip-y', this.config.flipY ? '1' : '0',
      this.config.isPublic ? '--public' : '--private',
    ]
    const hp = new HelperProcess(this.config.helperPath, args, {
      onAck: (ack) => this.onAck(hp, ack),
      onExit: (code, signal, detail) => this.onHelperExit(hp, code, signal, detail),
    })
    this.helper = hp
    this.metrics.setHelperPid(hp.pid ?? null)
    this.startupTimer = setTimeout(() => {
      if (this.helper !== hp || this.gate.isReady()) return
      this.metrics.inc('timeouts')
      hp.kill('ready timeout')
    }, STARTUP_TIMEOUT_MS)
    this.startupTimer.unref?.()
  }

  private onAck(hp: HelperProcess, ack: AckHeader): void {
    if (this.disposed || this.helper !== hp) return
    if (ack.status === STATUS_READY) {
      if (this.startupTimer) clearTimeout(this.startupTimer)
      this.startupTimer = null
      this.gate.markReady()
      this.metrics.setReady(true)
      if (this.stableTimer) clearTimeout(this.stableTimer)
      this.stableTimer = setTimeout(() => { this.restartBudget.reset() }, STABLE_RESET_MS)
      this.stableTimer.unref?.()
      if (this.win) this.kick(this.win)
      return
    }

    if (ack.frameId !== this.inFlightId) {
      log.warn(`syphon-bridge: stale ack ${ack.frameId}, in flight ${this.inFlightId}`)
      return
    }
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    this.gate.ack()
    const ackMs = this.inFlightId ? performance.now() - this.lastSentAt : 0
    this.inFlightId = 0
    if (ack.status === STATUS_PUBLISHED) {
      this.metrics.inc('published')
      if (ackMs > 0) this.metrics.recordAck(ackMs)
      if (this.recovery.published()) this.requestFreshFrame()
      return
    }
    this.metrics.inc('helperFailures')
    this.recovery.reset()
    log.warn(`syphon-bridge: helper frame ${ack.frameId} status ${ack.status}`)
    if (ack.status === STATUS_BAD_FRAME || ack.status === STATUS_GPU_TIMEOUT ||
        ack.status === STATUS_INTERNAL || ack.status === STATUS_PROTOCOL_ERROR) {
      this.gate.markDead()
      hp.kill(`frame status ${ack.status}`)
    }
  }

  private onHelperExit(hp: HelperProcess, code: number | null, signal: NodeJS.Signals | null,
                       detail: string): void {
    if (this.helper !== hp) return
    this.helper = null
    this.gate.markDead()
    this.recovery.reset()
    this.metrics.setReady(false)
    this.metrics.setHelperPid(null)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    if (this.watchdog) clearTimeout(this.watchdog)
    this.startupTimer = this.stableTimer = this.watchdog = null
    this.inFlightId = 0
    if (this.disposed || this.failed) return
    log.warn(`syphon-bridge: helper ended (${detail}, code=${code}, signal=${signal})`)
    const delay = this.restartBudget.nextDelayMs()
    if (delay === null) {
      this.fail('helper restart limit reached')
      return
    }
    this.metrics.inc('helperRestarts')
    this.restartTimer = setTimeout(() => this.spawnHelper(), delay)
    this.restartTimer.unref?.()
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    this.metrics.inc('helperFailures')
    log.error(`syphon-bridge: disabled: ${reason}`)
    if (this.followTimer) clearInterval(this.followTimer)
    this.followTimer = null
    this.clearTimers()
    this.detachTap()
    releaseGhost('audience', HOLDER)
    this.helper?.destroyNow()
    this.helper = null
    this.gate.markDead()
    this.recovery.reset()
    this.metrics.stop()
  }

  private requestFreshFrame(): void {
    if (this.disposed || this.failed || !this.gate.isReady()) return
    const target = this.win
    if (!target || target.isDestroyed()) return
    // Exactly one refresh per skipped-while-busy transition. This obtains the
    // latest final composition without retaining NativeImage objects or bytes.
    target.webContents.invalidate()
  }
}

let bridge: SyphonBridge | null = null

/** Called only after the app is ready and the initial layout exists. */
export function initSyphonBridge(): void {
  if (bridge) return
  if (app.isPackaged || process.platform !== 'darwin') return
  if (process.env.CUEDECK_SYPHON_GPU === '1') return
  if (process.env.CUEDECK_SYPHON_GPU_AUDIENCE === '1') return
  if (process.env.CUEDECK_SYPHON_BRIDGE !== '1') return
  bridge = new SyphonBridge()
  bridge.start()
}

export function shutdownSyphonBridge(): void {
  bridge?.destroyNow()
  bridge = null
}
