import { beforeEach, expect, it, vi } from 'vitest'
const rt = vi.hoisted(() => ({ handlers: new Map<string, Function>(), wc: { mainFrame: {} }, setEnabled: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, fn: Function) => rt.handlers.set(key, fn) } }))
vi.mock('../src/main/windows', () => ({
  getOperatorWindow: () => ({ isDestroyed: () => false, webContents: rt.wc }),
  setAudienceOutputEnabled: rt.setEnabled,
}))
import { registerAudienceOutputIpc } from '../src/main/audience-output'
beforeEach(() => { rt.handlers.clear(); rt.setEnabled.mockClear(); registerAudienceOutputIpc() })
const call = (event: unknown, value: unknown) => rt.handlers.get('audience-output:set-enabled')!(event, value)
it('accepts only an operator main-frame boolean and leaves rejected calls without side effects', () => {
  for (const event of [{ sender: {} }, { sender: rt.wc, senderFrame: {} }]) expect(() => call(event, false)).toThrow('Operator')
  const operator = { sender: rt.wc, senderFrame: rt.wc.mainFrame }
  expect(() => call(operator, 'false')).toThrow('Boolean')
  expect(rt.setEnabled).not.toHaveBeenCalled()
  call(operator, false)
  expect(rt.setEnabled).toHaveBeenCalledExactlyOnceWith(false)
})

it('accepts the private remote capability but rejects a structurally identical object', async () => {
  const { REMOTE_EVENT } = await import('../src/main/remote/event')
  expect(() => call({ ...REMOTE_EVENT }, false)).toThrow('Operator')
  call(REMOTE_EVENT, false)
  expect(rt.setEnabled).toHaveBeenCalledExactlyOnceWith(false)
})
