import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const rt = vi.hoisted(() => ({
  getGPUInfo: vi.fn(async () => ({ gpuDevice: [
    { deviceString: 'Integrated GPU', gpuPreference: 2 },
    { deviceString: 'Discrete GPU', gpuPreference: 3 },
  ] })),
  openExternal: vi.fn(async () => undefined),
  handlers: new Map<string, Function>(),
  wc: { mainFrame: {} },
}))

vi.mock('electron', () => ({
  app: { getGPUInfo: rt.getGPUInfo },
  shell: { openExternal: rt.openExternal },
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

it('keeps the prompter channels separate and applies the same operator check', async () => {
  const prompter = { getStatus: vi.fn(() => ({ ...status, name: 'CueDeck Prompter' })),
    configure: vi.fn(async () => ({ ok: true as const, status: { ...status, name: 'CueDeck Prompter' } })) }
  registerSyphonIpc(prompter, 'syphon-prompter')
  await expect(call('syphon-prompter:configure', { sender: {} }, { enabled: true })).rejects.toThrow('Operator')
  await expect(call('syphon-prompter:configure', operator, { enabled: true })).resolves.toMatchObject({ ok: true })
  expect(prompter.configure).toHaveBeenCalledWith({ enabled: true })
  expect(target.configure).not.toHaveBeenCalled()
  expect(call('syphon-prompter:status', operator).name).toBe('CueDeck Prompter')
  expect(call('syphon:status', operator).name).toBe(status.name)
})

it('accepts private main-process remote identity and rejects a forged copy', async () => {
  const { REMOTE_EVENT } = await import('../src/main/remote/event')
  await expect(call('syphon:configure', { ...REMOTE_EVENT }, { enabled: true })).rejects.toThrow('Operator')
  await expect(call('syphon:configure', REMOTE_EVENT, { enabled: true })).resolves.toMatchObject({ ok: true })
})


afterEach(() => vi.unstubAllGlobals())

it('blocks Windows help and settings on macOS and for remote callers', async () => {
  rt.openExternal.mockClear()
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  await expect(call('spout:graphics-help', operator)).rejects.toThrow('Local Windows')
  await expect(call('spout:open-graphics-settings', operator)).rejects.toThrow('Local Windows')
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const { REMOTE_EVENT } = await import('../src/main/remote/event')
  for (const event of [{ sender: {} }, REMOTE_EVENT]) {
    await expect(call('spout:graphics-help', event)).rejects.toThrow()
    await expect(call('spout:open-graphics-settings', event)).rejects.toThrow()
  }
  expect(rt.openExternal).not.toHaveBeenCalled()
})

it('matches GPU names and commands to Windows modes and safely quotes the EXE path', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32', execPath: "C:\\O'Brien\\CueDeck.exe" })
  rt.openExternal.mockClear()
  const info = await call('spout:graphics-help', operator)
  expect(info.exePath).toBe(process.execPath)
  expect(info.options.map((o: any) => [o.preference, o.name])).toEqual([[1, 'Integrated GPU'], [2, 'Discrete GPU']])
  for (const option of info.options) {
    expect(option.powershell).toContain("-Name 'C:\\O''Brien\\CueDeck.exe'")
    expect(option.powershell).toContain(`-Value ('GpuPreference=${option.preference};' + $cueDeckGpuValue)`)
    expect(option.powershell).toContain('Get-ItemPropertyValue')
    expect(option.powershell).toContain("-notmatch '^GpuPreference='")
    expect(option.powershell).toContain('HKCU:')
  }
  expect(rt.openExternal).not.toHaveBeenCalled()
})

it('keeps Windows mode selection available if GPU identification fails', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  rt.getGPUInfo.mockRejectedValueOnce(new Error('GPU info unavailable'))
  const info = await call('spout:graphics-help', operator)
  expect(info.options.map((o: any) => [o.preference, o.name])).toEqual([[1, null], [2, null]])
})

it('opens only the fixed settings URI and reports launch failure to the renderer', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  rt.openExternal.mockClear()
  await call('spout:open-graphics-settings', operator, 'https://ignored.invalid')
  expect(rt.openExternal).toHaveBeenCalledExactlyOnceWith('ms-settings:display-advancedgraphics')
  rt.openExternal.mockRejectedValueOnce(new Error('No handler'))
  await expect(call('spout:open-graphics-settings', operator)).rejects.toThrow('No handler')
})
