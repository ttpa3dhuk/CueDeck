import type { BrowserWindow, NativeImage } from 'electron'
import { store } from './state.js'
import { createTimerOverlayWindow } from './windows.js'

type Transport = 'ndi' | 'omt'
interface TimerSender<Fps extends number> {
  readonly name: string
  readonly size: number
  readonly fps: Fps
  start(): void
  stop(): Promise<void>
  setFps(fps: Fps): void
  push(image: NativeImage): void
}
interface Sink {
  transport: Transport
  sender: Pick<TimerSender<number>, 'size' | 'fps' | 'push'>
}
interface Overlay {
  win: BrowserWindow
  height: number
  fps: number
  sinks: Sink[]
}

const sinks = new Set<Sink>()
const overlays = new Map<boolean, Overlay>()
let unsubscribe: (() => void) | undefined

function reconcile(): void {
  const state = store.get()
  const active = [...sinks]
  const allShowMessages = active.every(s => state[s.transport].timerMessage)
  for (const showMessage of [false, true]) {
    const group = active.filter(({ transport }) =>
      Boolean((allShowMessages || state.speakerMessage) && state[transport].timerMessage) === showMessage)
    const overlay = overlays.get(showMessage)
    if (!group.length) {
      overlays.delete(showMessage)
      overlay?.win.destroy()
      continue
    }
    const height = Math.max(...group.map(s => s.sender.size))
    const fps = Math.max(...group.map(s => s.sender.fps))
    if (!overlay || overlay.height !== height) {
      const win = createTimerOverlayWindow(Math.round(height * 16 / 9), height, showMessage)
      const next = { win, height, fps, sinks: group }
      win.webContents.setFrameRate(fps)
      win.webContents.on('paint', (_event, _dirty, image) => {
        if (overlays.get(showMessage) === next) {
          for (const sink of next.sinks) sink.sender.push(image)
        }
      })
      overlays.set(showMessage, next)
      overlay?.win.destroy()
    } else {
      const joined = group.some(sink => !overlay.sinks.includes(sink))
      overlay.sinks = group
      if (overlay.fps !== fps) {
        overlay.win.webContents.setFrameRate(fps)
        overlay.fps = fps
      }
      if (joined) overlay.win.webContents.invalidate()
    }
  }
}

export class NetworkTimerOutput<Fps extends number, S extends TimerSender<Fps>> {
  private readonly sink: Sink
  constructor(transport: Transport, readonly sender: S) {
    this.sink = { transport, sender }
  }
  start(): void {
    this.sender.start()
    sinks.add(this.sink)
    unsubscribe ??= store.onChange((_state, patch) => {
      if ('speakerMessage' in patch || patch.ndi || patch.omt) reconcile()
    })
    reconcile()
  }
  setFps(fps: Fps): void {
    if (this.sender.fps === fps) return
    this.sender.setFps(fps)
    reconcile()
  }
  stop(): Promise<void> {
    sinks.delete(this.sink)
    if (!sinks.size) {
      unsubscribe?.()
      unsubscribe = undefined
    }
    reconcile()
    return this.sender.stop()
  }
}
