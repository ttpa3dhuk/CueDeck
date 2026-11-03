import { isRemoteControlEvent } from './remote/event.js'
import { app, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { store } from './state.js'
import { getOperatorWindow } from './windows.js'
import { type TestScreenInfo } from '../shared/test-screen.js'
import { currentDisplayMode } from './display-mode.js'

export function registerTestScreenIpc(): void {
  const requireOperator = (event: IpcMainInvokeEvent): void => {
    const operator = getOperatorWindow()
    if (!isRemoteControlEvent(event) && (!operator || operator.isDestroyed() || event.sender !== operator.webContents ||
      event.senderFrame !== operator.webContents.mainFrame)) throw new Error('Operator window required')
  }
  ipcMain.handle('test-screen:set-enabled', (event, enabled: unknown) => {
    requireOperator(event)
    if (typeof enabled !== 'boolean') throw new Error('Boolean required')
    store.patch({ testScreen: { ...store.get().testScreen, automatic: false, manual: enabled } })
  })
  ipcMain.handle('test-screen:info', (_event, role: unknown): TestScreenInfo => {
    if (role !== 'audience' && role !== 'speaker') throw new Error('Invalid output role')
    const state = store.get()
    // Hidden OMT/monitor outputs have no physical display assignment. Do not
    // substitute the operator's monitor and label it as the external output.
    const display = screen.getAllDisplays().find(display => display.id === state.displayMap[role])
    return { role, version: app.getVersion(), ...(display ? currentDisplayMode(display) : { width: null, height: null, refreshRate: null }) }
  })
}
