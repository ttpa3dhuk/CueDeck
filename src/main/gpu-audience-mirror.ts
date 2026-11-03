import { ipcMain, sharedTexture, type BrowserWindow, type OffscreenSharedTexture } from 'electron'

type TextureInfo = OffscreenSharedTexture['textureInfo']
interface Target {
  id: number
  win: BrowserWindow
  ready: Promise<void>
  resolve(): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  error: Error | null
  failed(error: Error): void
}
const targets = new Map<number, Target>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  ipcMain.on('gpu-view:ready', (event, result: { error?: string; adapter?: string }) => {
    const target = targets.get(event.sender.id)
    if (!target || event.senderFrame !== event.sender.mainFrame) return
    clearTimeout(target.timer)
    if (result?.error) {
      target.error = new Error(String(result.error).slice(0, 500))
      target.reject(target.error)
      target.failed(target.error)
    }
    else target.resolve()
  })
}

/** One GPU-only display consumer. It never decodes media or receives CPU pixels. */
export class GpuAudienceMirror {
  private target: Target | null = null
  private serial = 0
  readonly stats = { imported: 0, released: 0, errors: 0 }

  constructor(private readonly onError: (error: Error) => void = () => undefined) {}

  static available(): boolean {
    return typeof sharedTexture?.importSharedTexture === 'function'
  }

  attach(win: BrowserWindow): void {
    this.detach()
    listen()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // A view may close before a frame asks for it. Keep that rejection handled.
    void ready.catch(() => undefined)
    const timer = setTimeout(() => reject(new Error('GPU display receiver did not become ready')), 8000)
    timer.unref?.()
    const target: Target = { id: win.webContents.id, win, ready, resolve, reject, timer,
      error: null, failed: error => this.onError(error) }
    this.target = target
    targets.set(win.webContents.id, target)
    win.once('closed', () => { if (this.target === target) this.detach() })
  }

  detach(): void {
    const target = this.target
    if (!target) return
    this.target = null
    targets.delete(target.id)
    clearTimeout(target.timer)
    target.reject(new Error('GPU display closed before it became ready'))
  }

  async consume(info: TextureInfo): Promise<void> {
    const target = this.target
    if (!target) return
    try { await target.ready }
    catch (error) {
      // A layout change may replace/close a display before its receiver loads.
      // It did not import this frame, so the remaining native output can proceed.
      if (this.target !== target) return
      throw error
    }
    if (target.error) throw target.error
    if (this.target !== target || target.win.isDestroyed()) return
    await new Promise<void>((resolve, reject) => {
      let transferError: unknown
      let imported: ReturnType<typeof sharedTexture.importSharedTexture>
      try {
        imported = sharedTexture.importSharedTexture({
          textureInfo: info,
          allReferencesReleased: () => {
            this.stats.released++
            if (transferError || target.error) reject(transferError || target.error)
            else resolve()
          },
        })
        this.stats.imported++
      } catch (error) { this.stats.errors++; reject(error); return }
      void (async () => {
        try {
          await sharedTexture.sendSharedTexture({
            frame: target.win.webContents.mainFrame,
            importedSharedTexture: imported,
          }, { kind: 'audience-gpu', serial: ++this.serial })
        } catch (error) {
          // A layout change can close a display during the transfer. Chromium
          // still owns its import until the callback below, but native sharing
          // should continue when this receiver was deliberately detached.
          if (this.target === target && !target.win.isDestroyed()) {
            this.stats.errors++
            transferError = error
          }
        }
        finally { imported.release() }
      })()
    })
  }
}
