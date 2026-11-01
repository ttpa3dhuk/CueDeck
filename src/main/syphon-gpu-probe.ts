/**
 * Synthetic first-gate GPU export probe (macOS, Electron 33.4.11).
 *
 * A hidden OFFSCREEN test canvas produces OffscreenSharedTexture paint events.
 * The proven in-process GPU publisher owns texture lifetime/completion. This
 * module is test-only and loads gpu-test/index.html; the real audience mode
 * uses the same publisher but loads the actual audience renderer.
 */
import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { GpuTexturePublisher, type GpuPaintSource } from './syphon-gpu-publisher.js'

const DEFAULT_NAME = 'CueDeck Syphon GPU Probe'
const TEST_WIDTH = 640
const TEST_HEIGHT = 360

function envFlag(name: string): boolean { return process.env[name] === '1' }
function nativePath(): string {
  const configured = process.env.CUEDECK_SYPHON_GPU_NATIVE
  if (configured) return isAbsolute(configured) ? configured : resolve(app.getAppPath(), configured)
  return join(app.getAppPath(), 'native', 'syphon-probe', 'build', 'libcuedeck_syphon_gpu.dylib')
}
function testPagePath(): string {
  return join(app.getAppPath(), 'native', 'syphon-probe', 'gpu-test', 'index.html')
}
function numericEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

export class SyphonGpuProbe {
  private readonly config = {
    nativePath: nativePath(),
    pagePath: testPagePath(),
    name: (process.env.CUEDECK_SYPHON_GPU_NAME ?? DEFAULT_NAME).slice(0, 128),
    isPublic: envFlag('CUEDECK_SYPHON_GPU_PUBLIC'),
    flipY: envFlag('CUEDECK_SYPHON_GPU_FLIP_Y'),
    timeoutMs: numericEnv('CUEDECK_SYPHON_GPU_TIMEOUT_MS', 5000, 500, 15000),
    firstTextureMs: numericEnv('CUEDECK_SYPHON_GPU_FIRST_TEXTURE_MS', 3000, 500, 10000),
  }
  private publisher: GpuTexturePublisher | null = null
  private win: BrowserWindow | null = null
  private disposed = false
  private failed = false

  start(): void {
    if (this.disposed) return
    const win = this.createTestWindow()
    if (!win || this.failed || this.disposed) return
    this.publisher = new GpuTexturePublisher(
      this.config,
      () => this.source(),
      (reason) => this.fail(reason),
    )
    this.publisher.start()
    log.info('syphon-gpu: OFFSCREEN TEST canvas only (not audience); audience mode is separate')
    void win.loadFile(this.config.pagePath).catch((error: Error) => this.fail(`load test page: ${error.message}`))
  }

  destroyNow(): void {
    if (this.disposed) return
    this.disposed = true
    this.publisher?.destroyNow()
    this.publisher = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    log.info('syphon-gpu: probe stopped')
  }

  private source(): GpuPaintSource | null {
    const win = this.win
    if (!win || win.isDestroyed()) return null
    return {
      webContents: win.webContents,
      isDestroyed: () => win.isDestroyed(),
      invalidate: () => win.webContents.invalidate(),
    }
  }

  private createTestWindow(): BrowserWindow | null {
    if (this.failed || this.disposed) return null
    const win = new BrowserWindow({
      width: TEST_WIDTH, height: TEST_HEIGHT, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000',
      webPreferences: {
        offscreen: { useSharedTexture: true },
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    this.win = win
    win.webContents.setFrameRate(30)
    win.webContents.on('paint', (event) => {
      if (this.publisher) this.publisher.onPaint(event)
      else try { event.texture?.release() } catch { /* window is stopping */ }
    })
    win.webContents.once('did-finish-load', () => {
      if (this.disposed || win.isDestroyed()) return
      win.webContents.startPainting()
      win.webContents.invalidate()
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => this.fail(`test page load: ${code} ${desc}`))
    win.once('closed', () => { if (!this.disposed && this.win === win) this.fail('test window closed') })
    return win
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    log.error(`syphon-gpu: disabled: ${reason}`)
    this.publisher?.destroyNow()
    this.publisher = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

let probe: SyphonGpuProbe | null = null

/** Synthetic test canvas only; never loads the audience renderer. */
export function initSyphonGpuProbe(): void {
  if (probe) return
  if (app.isPackaged || process.platform !== 'darwin') return
  if (process.env.CUEDECK_SYPHON_GPU !== '1') return
  if (process.env.CUEDECK_SYPHON_GPU_AUDIENCE === '1') {
    log.warn('syphon-gpu: synthetic probe refuses to run together with CUEDECK_SYPHON_GPU_AUDIENCE=1')
    return
  }
  if (process.env.CUEDECK_SYPHON_BRIDGE === '1') {
    log.warn('syphon-gpu: refuses to run together with CUEDECK_SYPHON_BRIDGE=1')
    return
  }
  if (!existsSync(nativePath())) {
    log.error(`syphon-gpu: native publisher not found: ${nativePath()}`)
    return
  }
  probe = new SyphonGpuProbe()
  probe.start()
}

export function shutdownSyphonGpuProbe(): void {
  probe?.destroyNow()
  probe = null
}
