import type { IpcMainInvokeEvent } from 'electron'

/** Private main-process capability; renderer objects cannot reproduce identity. */
export const REMOTE_EVENT = Object.freeze({ sender: null, frameId: -1, processId: -1 }) as unknown as IpcMainInvokeEvent
export const isRemoteControlEvent = (event: unknown): boolean => event === REMOTE_EVENT
