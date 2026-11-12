import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ enabled: true }))
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  BrowserWindow: {}, dialog: {}, shell: {},
  ipcMain: { handle: vi.fn() },
}))
vi.mock('../src/main/diag', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/display-mapping', () => ({
  getRemoteSettings: () => ({ enabled: runtime.enabled, httpPort: 0, oscPort: 0, lan: false, companionPush: false, companionHost: '127.0.0.1:8000' }),
  getMidiInputs: () => [], setMidiInputs: vi.fn(), setRemoteSettings: vi.fn(), validHost: () => null,
}))
vi.mock('../src/main/remote/companion-push', () => ({ configureCompanionPush: vi.fn() }))

import { ipcMain } from 'electron'
import { initialState, store } from '../src/main/state'
import { captureIpcHandlers, initRemote } from '../src/main/remote/server'

let port: number
const starts = vi.fn(() => store.patchTimer({ running: true, startedAt: Date.now() }))
const servers: http.Server[] = []
const originalCreateServer = http.createServer
const createServer = vi.spyOn(http, 'createServer').mockImplementation((...args: Parameters<typeof http.createServer>) => {
  const server = originalCreateServer(...args)
  servers.push(server)
  return server
})

function request(method: string, path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('test HTTP timeout')))
    req.end()
  })
}

beforeAll(async () => {
  captureIpcHandlers()
  ipcMain.handle('timer:start', starts)
  await initRemote()
  const server = servers.find(s => (s.address() as AddressInfo | null)?.family === 'IPv4')
  if (!server) throw new Error('test server did not bind IPv4 loopback')
  port = (server.address() as AddressInfo).port
})
beforeEach(() => {
  store.patch(initialState())
  starts.mockClear()
})
afterAll(async () => {
  runtime.enabled = false
  await initRemote()
  createServer.mockRestore()
})

describe('remote HTTP method compatibility', () => {
  it.each(['GET', 'POST'])('rejects cross-site %s without executing a command when the key is off', async method => {
    const res = await request(method, '/api/timer/start', { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })
    expect(res.status).toBe(403)
    expect(starts).not.toHaveBeenCalled()
    expect(store.get().timer.running).toBe(false)
  })
  it.each(['GET', 'POST'])('%s still executes an existing controller command exactly once', async method => {
    const res = await request(method, '/api/timer/start')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, command: 'timer/start' })
    expect(starts).toHaveBeenCalledTimes(1)
    expect(store.get().timer.running).toBe(true)
  })

  it('HEAD on a command does not execute it', async () => {
    const res = await request('HEAD', '/api/timer/start')
    expect(starts).not.toHaveBeenCalled()
    expect(store.get().timer.running).toBe(false)
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('GET, POST')
    expect(res.body).toBe('')
  })

  it.each(['/', '/api/state', '/api/timer/text'])('HEAD on %s remains read-only and available', async path => {
    const res = await request('HEAD', path)
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
    expect(starts).not.toHaveBeenCalled()
    expect(store.get().timer.running).toBe(false)
  })

  it.each(['OPTIONS', 'PUT', 'DELETE'])('%s cannot execute a command', async method => {
    expect((await request(method, '/api/timer/start')).status).toBe(405)
    expect(starts).not.toHaveBeenCalled()
  })
})
