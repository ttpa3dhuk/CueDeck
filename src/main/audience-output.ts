import { isRemoteControlEvent } from './remote/event.js'
import { ipcMain } from 'electron'
import { getOperatorWindow, setAudienceOutputEnabled } from './windows.js'

export function registerAudienceOutputIpc(): void {
  ipcMain.handle('audience-output:set-enabled', (event, enabled: unknown) => {
    const operator = getOperatorWindow()
    if (!isRemoteControlEvent(event) && (!operator || operator.isDestroyed() || event.sender !== operator.webContents ||
      event.senderFrame !== operator.webContents.mainFrame)) throw new Error('Operator window required')
    if (typeof enabled !== 'boolean') throw new Error('Boolean required')
    setAudienceOutputEnabled(enabled)
  })
}
