import { isRemoteControlEvent } from './remote/event.js'
/**
 * Operator-only IPC for the Syphon output setting.
 *
 * The renderer sends only { enabled, name }; native paths, environment and the
 * runtime mode stay in main. Status is also pushed through state.syphon, but
 * this channel lets the settings dialog show the real result immediately.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { getOperatorWindow } from './windows.js'
import type { SyphonSettings, SyphonStatus } from '../shared/types.js'
import type { SyphonConfigureResult } from './syphon-settings.js'

export interface SyphonIpcTarget {
  getStatus(): SyphonStatus
  configure(raw: unknown): Promise<SyphonConfigureResult>
}

function requireOperator(event: IpcMainInvokeEvent): void {
  const operator = getOperatorWindow()
  if (!isRemoteControlEvent(event) && (!operator || operator.isDestroyed() || event.sender !== operator.webContents ||
    event.senderFrame !== operator.webContents.mainFrame)) throw new Error('Operator window required')
}

export function registerSyphonIpc(target: SyphonIpcTarget): void {
  ipcMain.handle('syphon:status', (event) => {
    requireOperator(event)
    return target.getStatus()
  })
  ipcMain.handle('syphon:configure', async (event, raw: unknown) => {
    requireOperator(event)
    // The manager re-validates too; this keeps the channel contract explicit.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings object required')
    return target.configure(raw as Partial<SyphonSettings>)
  })
}
