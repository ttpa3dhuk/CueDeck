import { beforeEach, expect, it, vi } from 'vitest'

const rt = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  wc: { mainFrame: {} },
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (key: string, fn: Function) => rt.handlers.set(key, fn) },
}))
vi.mock('../src/main/windows', () => ({
  getOperatorWindow: () => ({ isDestroyed: () => false, webContents: rt.wc }),
}))

import { registerSyphonIpc } from '../src/main/syphon-settings-ipc'
import { defaultSyphonStatus } from '../src/shared/types'

const status = defaultSyphonStatus()
const target = {
  getStatus: vi.fn(() => status),
  configure: vi.fn(async () => ({ ok: true as const, status })),
}
const operator = { sender: rt.wc, senderFrame: rt.wc.mainFrame }
const call = (name: string, event: unknown, ...args: unknown[]) => rt.handlers.get(name)!(event, ...args)

beforeEach(() => {
  rt.handlers.clear()
  target.getStatus.mockClear()
  target.configure.mockClear()
  registerSyphonIpc(target)
})

it('allows only the operator main frame to read or change the Syphon setting', async () => {
  for (const event of [{ sender: {} }, { sender: rt.wc, senderFrame: {} }]) {
    expect(() => call('syphon:status', event)).toThrow('Operator')
    await expect(call('syphon:configure', event, { enabled: true })).rejects.toThrow('Operator')
  }
  expect(target.getStatus).not.toHaveBeenCalled()
  expect(target.configure).not.toHaveBeenCalled()
})

it('passes only the settings object to the manager and rejects non-objects', async () => {
  await expect(call('syphon:configure', operator, { enabled: true, name: 'Hall' })).resolves.toMatchObject({ ok: true })
  expect(target.configure).toHaveBeenCalledWith({ enabled: true, name: 'Hall' })
  for (const raw of [null, [], 'enabled']) {
    await expect(call('syphon:configure', operator, raw)).rejects.toThrow('object')
  }
  expect(target.configure).toHaveBeenCalledTimes(1)
})

it('returns the real runtime status to the operator', () => {
  expect(call('syphon:status', operator)).toBe(status)
  expect(target.getStatus).toHaveBeenCalledOnce()
})
