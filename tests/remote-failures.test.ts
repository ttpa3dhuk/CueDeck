import dgram from 'node:dgram'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { DEFAULT_REMOTE_SETTINGS, type RemoteSettings } from '../src/shared/types'

const rt = vi.hoisted(() => ({
  handlers: new Map<string, Function>(), wc: { mainFrame: {} },
  saved: {} as RemoteSettings, key: vi.fn(async () => 'a'.repeat(64)),
}))
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' }, BrowserWindow: {}, dialog: {}, shell: {}, clipboard: {},
  ipcMain: { handle: (name: string, fn: Function) => rt.handlers.set(name, fn) },
}))
vi.mock('../src/main/windows', () => ({ getOperatorWindow: () => ({ webContents: rt.wc }) }))
vi.mock('../src/main/remote/access-key', () => ({ remoteAccessKey: rt.key }))
vi.mock('../src/main/diag', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/display-mapping', () => ({
  getRemoteSettings: () => rt.saved, setRemoteSettings: (v: RemoteSettings) => { rt.saved = v },
  validHost: () => null, getMidiInputs: () => [], setMidiInputs: vi.fn(),
}))
vi.mock('../src/main/remote/companion-push', () => ({ configureCompanionPush: vi.fn() }))

import { ipcMain } from 'electron'
import { initialState, store } from '../src/main/state'
import { captureIpcHandlers, initRemote, registerRemoteIpc } from '../src/main/remote/server'

const servers: http.Server[] = [], sockets: dgram.Socket[] = []
const createHttp = http.createServer, createUdp = dgram.createSocket
const httpSpy = vi.spyOn(http, 'createServer').mockImplementation((...args: Parameters<typeof http.createServer>) => {
  const server = createHttp(...args); servers.push(server); return server
})
const udpSpy = vi.spyOn(dgram, 'createSocket').mockImplementation((...args: Parameters<typeof dgram.createSocket>) => {
  const socket = createUdp(...args); sockets.push(socket); return socket
})
captureIpcHandlers()
const operator = () => ({ sender: rt.wc, senderFrame: rt.wc.mainFrame }) as unknown as IpcMainInvokeEvent
const configure = (patch: Partial<RemoteSettings>) => rt.handlers.get('remote:configure')!(operator(), { ...rt.saved, ...patch })
const portOf = (server: http.Server) => (server.address() as AddressInfo).port
const activeHttp = () => [...servers].reverse().find(server => (server.address() as AddressInfo | null)?.family === 'IPv4')!
const closeHttp = (server: http.Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
const closeUdp = (socket: dgram.Socket) => new Promise<void>(resolve => socket.close(() => resolve()))

function request(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, agent: false }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!))
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('test HTTP timeout')))
  })
}

beforeEach(async () => {
  const probe = createUdp('udp4')
  await new Promise<void>(resolve => probe.bind(0, '127.0.0.1', resolve))
  const oscPort = (probe.address() as AddressInfo).port
  await closeUdp(probe)
  rt.saved = { ...DEFAULT_REMOTE_SETTINGS, enabled: false, companionPush: false, httpPort: 0, oscPort }
  rt.handlers.clear(); rt.key.mockReset().mockResolvedValue('a'.repeat(64))
  store.patch(initialState()); registerRemoteIpc(); await initRemote()
})
afterEach(async () => {
  rt.saved = { ...rt.saved, enabled: false }; await initRemote()
  servers.length = 0; sockets.length = 0
})

it('reports occupied TCP/UDP ports without dropping protection, then recovers after release', async () => {
  const blocker = createHttp((_req, res) => res.end('occupied'))
  const neighbor = createHttp((_req, res) => res.end('neighbor'))
  const udp = createUdp('udp4')
  await new Promise<void>(resolve => blocker.listen(0, '0.0.0.0', resolve))
  await new Promise<void>(resolve => neighbor.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve))
  const httpPort = portOf(blocker), oscPort = (udp.address() as AddressInfo).port
  try {
    rt.saved = { ...rt.saved, enabled: true, lan: true, networkAuth: true, httpPort, oscPort }
    await initRemote()
    expect(store.get().remote).toMatchObject({ networkAuth: true, http: 'error', osc: 'error' })
    expect(store.get().remote.httpError).toContain(String(httpPort))
    expect(store.get().remote.oscError).toContain(String(oscPort))
    expect(rt.saved.networkAuth).toBe(true)
    expect(await request(portOf(neighbor), '/')).toBe(200)
    await closeHttp(blocker); await closeUdp(udp)
    await initRemote()
    expect(store.get().remote).toMatchObject({ networkAuth: true, http: 'on', osc: 'on', httpError: null, oscError: null })
    expect(await request(httpPort, '/api/state')).toBe(200)
    expect(await request(portOf(neighbor), '/')).toBe(200)
  } finally {
    if (blocker.listening) await closeHttp(blocker)
    try { udp.address(); await closeUdp(udp) } catch { /* Already closed by the recovery step. */ }
    await closeHttp(neighbor)
  }
})

it('retains a working listener and saved settings if enabling protection cannot open the key', async () => {
  rt.saved = { ...rt.saved, enabled: true, httpPort: 0 }
  await initRemote()
  const server = activeHttp(), port = portOf(server), before = { ...rt.saved }
  rt.key.mockRejectedValue(new Error('native storage unavailable'))
  expect(await configure({ networkAuth: true })).toMatchObject({ ok: false })
  expect(rt.saved).toEqual(before)
  expect(activeHttp()).toBe(server)
  expect(await request(port, '/api/state')).toBe(200)
  rt.key.mockResolvedValue('a'.repeat(64))
  expect(await configure({ networkAuth: true })).toMatchObject({ ok: true })
  expect(store.get().remote).toMatchObject({ networkAuth: true, networkAuthError: null })
})

it.each(['unchanged', 'networkAuth', 'lan'] as const)('rechecks queued OSC with policy %s', async policy => {
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const reset = vi.fn(() => ({ ok: true }))
  ipcMain.handle('timer:start', async () => { entered(); await blocked; return { ok: true } })
  ipcMain.handle('timer:reset', reset)
  rt.saved = { ...rt.saved, enabled: true, lan: true, httpPort: 0 }
  await initRemote()
  // A genuine TCP request blocks the execution queue. Inject only the UDP peer
  // metadata so this race regression also runs on CI without a LAN interface.
  const pending = request(portOf(activeHttp()), '/api/timer/start').catch(() => 0)
  try {
    await waiting
    const address = Buffer.from('/cuedeck/timer/reset\0')
    const packet = Buffer.concat([address, Buffer.alloc((4 - address.length % 4) % 4), Buffer.from(',\0\0\0')])
    sockets.at(-1)!.emit('message', packet, { address: '192.0.2.10', family: 'IPv4', port: 9000, size: packet.length })
    if (policy !== 'unchanged') {
      const patch = policy === 'networkAuth' ? { networkAuth: true } : { lan: false }
      expect(await configure(patch)).toMatchObject({ ok: true })
    }
    release(); await pending
    await new Promise(resolve => setImmediate(resolve))
    expect(reset).toHaveBeenCalledTimes(policy === 'unchanged' ? 1 : 0)
  } finally { release(); await pending }
})

it('discards a queued HTTP command when control is disabled before execution', async () => {
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const reset = vi.fn(() => ({ ok: true }))
  ipcMain.handle('timer:start', async () => { entered(); await blocked; return { ok: true } })
  ipcMain.handle('timer:reset', reset)
  rt.saved = { ...rt.saved, enabled: true, httpPort: 0 }
  await initRemote()
  const server = activeHttp(), port = portOf(server)
  const first = request(port, '/api/timer/start').catch(() => 0)
  let second: Promise<number> = Promise.resolve(0)
  try {
    await waiting
    const received = new Promise<void>(resolve => server.once('request', () => resolve()))
    second = request(port, '/api/timer/reset').catch(() => 0)
    await received
    expect(await configure({ enabled: false })).toMatchObject({ ok: true })
    release(); await Promise.all([first, second])
    await new Promise(resolve => setImmediate(resolve))
    expect(reset).not.toHaveBeenCalled()
  } finally { release(); await Promise.all([first, second]) }
})

afterEach(() => { httpSpy.mockClear(); udpSpy.mockClear() })
