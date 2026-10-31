import { beforeEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { DEFAULT_REMOTE_SETTINGS } from '../src/shared/types'
import { t } from '../src/shared/i18n'

const rt = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  wc: { mainFrame: {} },
  saved: {} as import('../src/shared/types').RemoteSettings,
  copied: vi.fn(),
  key: vi.fn(async () => 'a'.repeat(64)),
}))
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' }, BrowserWindow: {}, dialog: {}, shell: {},
  clipboard: { writeText: rt.copied },
  ipcMain: { handle: (name: string, fn: Function) => rt.handlers.set(name, fn) },
}))
vi.mock('../src/main/windows', () => ({ getOperatorWindow: () => ({ webContents: rt.wc }) }))
vi.mock('../src/main/remote/access-key', () => ({ remoteAccessKey: rt.key }))
vi.mock('../src/main/diag', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/display-mapping', () => ({
  getRemoteSettings: () => rt.saved,
  setRemoteSettings: (settings: typeof rt.saved) => { rt.saved = settings },
  validHost: () => null, getMidiInputs: () => [], setMidiInputs: vi.fn(),
}))
vi.mock('../src/main/remote/companion-push', () => ({ configureCompanionPush: vi.fn() }))

import { callIpcHandler, captureIpcHandlers, initRemote, registerRemoteIpc } from '../src/main/remote/server'
import { store } from '../src/main/state'
const operator = () => ({ sender: rt.wc, senderFrame: rt.wc.mainFrame }) as unknown as IpcMainInvokeEvent
const call = (channel: string, event: unknown, ...args: unknown[]) => rt.handlers.get(channel)!(event, ...args)
captureIpcHandlers()

beforeEach(async () => {
  rt.saved = { ...DEFAULT_REMOTE_SETTINGS, enabled: false, companionPush: false }
  rt.key.mockReset().mockResolvedValue('a'.repeat(64))
  rt.copied.mockClear()
  rt.handlers.clear()
  registerRemoteIpc()
  await initRemote()
})

it('copies a key only from the operator main frame and never returns it over IPC', async () => {
  for (const event of [{ sender: {} }, { sender: rt.wc, senderFrame: {} }]) {
    expect((await call('remote:copy-access-key', event)).ok).toBe(false)
  }
  expect(rt.key).not.toHaveBeenCalled()
  const response = await call('remote:copy-access-key', operator())
  expect(response).toEqual({ ok: true })
  expect(rt.copied).toHaveBeenCalledWith('a'.repeat(64))
  expect(JSON.stringify(store.get())).not.toContain('a'.repeat(64))
})

it('waits for asynchronous clipboard writes and handles their rejection on newer Electron', async () => {
  let finish!: () => void
  rt.copied.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  let completed = false
  const response = call('remote:copy-access-key', operator()).then((value: unknown) => {
    completed = true
    return value
  })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(completed).toBe(false)
  finish()
  expect(await response).toEqual({ ok: true })
  expect(await call('remote:configure', operator(), { ...rt.saved, networkAuth: true })).toMatchObject({ ok: true })
  rt.copied.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  expect(await call('remote:copy-access-key', operator())).toEqual({
    ok: false, error: t('Не удалось скопировать ключ доступа. Повторите попытку.'),
  })
  expect(store.get().remote.networkAuth).toBe(true)
})

it('requires the operator to change protection and keeps old profiles from disabling it', async () => {
  expect((await call('remote:configure', {}, { ...rt.saved, networkAuth: true })).ok).toBe(false)
  expect(rt.saved.networkAuth).toBe(false)
  expect((await call('remote:configure', operator(), { ...rt.saved, networkAuth: true })).ok).toBe(true)
  expect(rt.saved.networkAuth).toBe(true)
  const { networkAuth: _auth, ...oldProfile } = rt.saved
  expect((await callIpcHandler('remote:configure', oldProfile) as { ok: boolean }).ok).toBe(true)
  expect(rt.saved.networkAuth).toBe(true)
  expect((await call('remote:configure', {}, { ...oldProfile, networkAuth: false })).ok).toBe(false)
  expect(rt.saved.networkAuth).toBe(true)
  expect((await call('remote:configure', operator(), { ...oldProfile, networkAuth: false })).ok).toBe(true)
})

it('does not let another renderer open an unprotected LAN listener', async () => {
  expect((await call('remote:configure', { sender: {} }, { ...rt.saved, enabled: true, lan: true })).ok).toBe(false)
  expect(rt.saved.enabled).toBe(false)
  expect(rt.saved.lan).toBe(false)
})

it('does not enable protection if the key cannot be stored', async () => {
  rt.key.mockRejectedValue(new Error('storage unavailable'))
  expect((await call('remote:configure', operator(), { ...rt.saved, networkAuth: true })).ok).toBe(false)
  expect(rt.saved.networkAuth).toBe(false)
  expect(store.get().remote.networkAuth).toBe(false)
})

it('preserves saved protection when the key cannot be opened at startup', async () => {
  rt.saved.networkAuth = true
  rt.key.mockRejectedValue(new Error('storage unavailable'))
  await initRemote()
  expect(store.get().remote.networkAuth).toBe(true)
  expect(store.get().remote.networkAuthError).toBeTruthy()
})
