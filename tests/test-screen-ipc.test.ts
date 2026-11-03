import { beforeEach, expect, it, vi } from 'vitest'
const rt = vi.hoisted(() => ({ handlers: new Map<string, Function>(), wc: { mainFrame: {} } }))
vi.mock('electron', () => ({ app: {}, screen: {}, BrowserWindow: class {}, ipcMain: { handle: (key: string, fn: Function) => rt.handlers.set(key, fn) } }))
vi.mock('../src/main/windows', () => ({ getOperatorWindow: () => ({ isDestroyed: () => false, webContents: rt.wc }) }))
import { registerTestScreenIpc } from '../src/main/test-screen'
import { initialState, store } from '../src/main/state'
import { REMOTE_EVENT } from '../src/main/remote/event'
beforeEach(() => { store.patch(initialState()); rt.handlers.clear(); registerTestScreenIpc() })
it('admits the private remote capability, rejects copies and validates boolean', () => {
  const call = (event: unknown, value: unknown) => rt.handlers.get('test-screen:set-enabled')!(event, value)
  for (const event of [{ ...REMOTE_EVENT }, { sender: rt.wc, senderFrame: {} }]) expect(() => call(event, true)).toThrow('Operator')
  expect(() => call(REMOTE_EVENT, 'true')).toThrow('Boolean')
  expect(store.get().testScreen.manual).toBe(false)
  call(REMOTE_EVENT, true)
  expect(store.get().testScreen).toEqual({ manual: true, automatic: false })
})
