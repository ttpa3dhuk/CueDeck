import type { FrameStepIdentity, VideoDeck, VideoRangeEdge } from '../shared/types.js'
import type { VideoInOutController } from './video-inout.js'

/** Structural subset of Electron's ipcMain, so handler wiring is testable. */
export interface VideoIpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

type VideoInOutHandlers = Pick<VideoInOutController, 'stepFrame' | 'setRange' | 'timecode'>

/** Register the two new channels; the rest of ipc.ts owns the application. */
export function registerVideoInOutIpc(ipc: VideoIpcRegistrar, controller: VideoInOutHandlers): void {
  ipc.handle('video:step-frame', async (_event, payload: { deck?: VideoDeck; direction?: number; identity?: FrameStepIdentity } | null) => {
    const deck: VideoDeck = payload?.deck === 'preview' ? 'preview' : 'program'
    return controller.stepFrame(deck, payload?.direction === -1 ? -1 : 1, payload?.identity)
  })

  ipc.handle('video:timecode', (_event, deck: VideoDeck) => {
    return controller.timecode(deck === 'preview' ? 'preview' : 'program')
  })

  ipc.handle('video:set-range', (_event, payload: { deck?: VideoDeck; edge?: VideoRangeEdge } | null) => {
    const deck: VideoDeck = payload?.deck === 'preview' ? 'preview' : 'program'
    const edge = payload?.edge
    if (edge !== 'in' && edge !== 'out' && edge !== 'reset' && edge !== 'clear-in' && edge !== 'clear-out') return { ok: false, code: 'invalid-range' }
    return controller.setRange(deck, edge)
  })
}
