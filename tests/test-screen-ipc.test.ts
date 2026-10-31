import { beforeEach, expect, it, vi } from 'vitest'
const rt = vi.hoisted(() => ({ handlers: new Map<string, Function>(), wc: { mainFrame: {} },
  mode: { width: 1920, height: 1080, refreshRate: 59.94 }, displays: [{ id: 3 }] }))
vi.mock('electron', () => ({ BrowserWindow: class {}, app: { getVersion: () => '0.12.0' },
  ipcMain: { handle: (key: string, fn: Function) => rt.handlers.set(key, fn) }, screen: { getAllDisplays: () => rt.displays } }))
vi.mock('../src/main/windows', () => ({ getOperatorWindow: () => ({ isDestroyed: () => false, webContents: rt.wc }) }))
vi.mock('../src/main/display-mode', () => ({ currentDisplayMode: () => ({ ...rt.mode }) }))
import { registerTestScreenIpc } from '../src/main/test-screen'
import { initialState, store } from '../src/main/state'
const operator = () => ({ sender: rt.wc, senderFrame: rt.wc.mainFrame })
const call = (name: string, event: unknown, ...args: unknown[]) => rt.handlers.get(name)!(event, ...args)
beforeEach(() => {
  store.patch(initialState()); rt.handlers.clear();
  rt.displays = [{ id: 3 }]; rt.mode = { width: 1920, height: 1080, refreshRate: 59.94 }
  registerTestScreenIpc()
})
it('allows only the operator main frame to enable the screen', () => {
  for (const event of [{ sender: {} }, { sender: rt.wc, senderFrame: {} }]) {
    expect(() => call('test-screen:set-enabled', event, true)).toThrow('Operator')
  }
  call('test-screen:set-enabled', operator(), true)
  expect(store.get().testScreen.manual).toBe(true)
  expect(() => call('test-screen:set-enabled', operator(), 'yes')).toThrow()
})
it('disabling the automatic screen retires it instead of revealing the startup logo again', () => {
  store.patch({ testScreen: { ...store.get().testScreen, automatic: true } })
  call('test-screen:set-enabled', operator(), false)
  expect(store.get().testScreen).toMatchObject({ automatic: false, manual: false })
})
it('reads current mode for the assigned output, updates it, and does not guess a display when absent', () => {
  store.patch({ displayMap: { operator: 1, audience: 3 } })
  expect(call('test-screen:info', {}, 'audience')).toMatchObject({ width: 1920, height: 1080, refreshRate: 59.94, version: '0.12.0' })
  rt.mode = { width: 1280, height: 720, refreshRate: 25 }
  expect(call('test-screen:info', {}, 'audience')).toMatchObject({ width: 1280, height: 720, refreshRate: 25 })
  rt.displays = []
  expect(call('test-screen:info', {}, 'audience')).toMatchObject({ width: null, height: null, refreshRate: null })
  expect(call('test-screen:info', {}, 'speaker')).toMatchObject({ width: null })
  expect(() => call('test-screen:info', {}, 'operator')).toThrow('Invalid output')
})
