/** Independent confidence-monitor producer using the same native GPU sender. */
import type { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { SYPHON_TARGET } from '../shared/types.js'
import { createGpuPrompterWindow, loadGpuPrompterPage } from './windows.js'
import { GpuTexturePublisher } from './syphon-gpu-publisher.js'
import type { GpuAudienceHooks, GpuAudienceOptions, GpuAudienceStartResult,
  GpuAudienceStopResult } from './syphon-gpu-audience.js'

export class GpuPrompterMode {
  private win: BrowserWindow | null = null
  private publisher: GpuTexturePublisher | null = null
  private disposed = false
  private failed = false
  private stopPromise: Promise<GpuAudienceStopResult> | null = null

  constructor(private readonly options: GpuAudienceOptions, private readonly hooks: GpuAudienceHooks) {}

  name(): string { return this.options.name }

  start(): GpuAudienceStartResult {
    if (this.disposed) return { ok: false, reason: 'runtime', detail: 'mode is disposed' }
    try {
      const win = createGpuPrompterWindow(false)
      this.win = win
      // The confidence monitor is video-only, including notification sounds.
      win.webContents.setAudioMuted(true)
      this.publisher = new GpuTexturePublisher({ ...this.options, targetSize: SYPHON_TARGET },
        () => this.win && !this.win.isDestroyed() ? {
          webContents: this.win.webContents,
          isDestroyed: () => !this.win || this.win.isDestroyed(),
          invalidate: () => this.win?.webContents.invalidate(),
        } : null,
        reason => this.fail(reason), () => this.hooks.onFirstTexture?.())
      win.webContents.on('paint', event => {
        if (this.publisher) this.publisher.onPaint(event)
        else try { event.texture?.release() } catch { /* stopping */ }
      })
      win.webContents.once('did-finish-load', () => {
        if (this.disposed || win.isDestroyed()) return
        win.webContents.startPainting()
        win.webContents.invalidate()
      })
      win.webContents.once('did-fail-load', (_event, code, description) =>
        this.fail(`prompter page load: ${code} ${description}`))
      win.once('closed', () => { if (!this.disposed) void this.stop('window-closed') })
      this.publisher.start()
      if (this.failed || this.disposed) return { ok: false, reason: 'runtime', detail: 'GPU publisher failed' }
      loadGpuPrompterPage(win)
      return { ok: true }
    } catch (error) {
      const detail = `create prompter: ${(error as Error).message}`
      this.fail(detail)
      return { ok: false, reason: 'runtime', detail }
    }
  }

  status(): { active: boolean; failed: boolean; actual: { width: number; height: number } | null; sawTexture: boolean } {
    const pub = this.publisher?.status()
    return { active: !this.disposed && this.publisher !== null, failed: this.failed,
      actual: pub && pub.width > 0 ? { width: pub.width, height: pub.height } : null,
      sawTexture: pub?.sawTexture ?? false }
  }

  stop(reason: string): Promise<GpuAudienceStopResult> {
    if (this.stopPromise) return this.stopPromise
    this.disposed = true
    this.hooks.onStopped?.(reason)
    const publisher = this.publisher
    this.publisher = null
    const win = this.win
    this.win = null
    try { if (win && !win.isDestroyed()) win.destroy() }
    catch (error) { log.warn(`GPU prompter window destroy: ${(error as Error).message}`) }
    this.stopPromise = (publisher ? publisher.stopAndWait(2000)
      : Promise.resolve({ released: true, timedOut: false })).then(result => {
      this.hooks.onStopResult?.(reason, result)
      return result
    }).catch(error => {
      const result = { released: false, timedOut: true }
      this.hooks.onFatal?.(`stop prompter: ${(error as Error).message}`)
      this.hooks.onStopResult?.(reason, result)
      return result
    })
    return this.stopPromise
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    this.hooks.onFatal?.(reason)
    void this.stop('error')
  }
}
