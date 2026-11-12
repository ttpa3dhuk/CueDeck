import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileClicker } from '../src/main/mobile-clicker'
import { DEFAULT_LANG, setLang } from '../src/shared/i18n'

let server: MobileClicker | null = null
beforeEach(() => setLang('ru'))
afterEach(async () => { await server?.dispose(); server = null; setLang(DEFAULT_LANG) })
async function start(command = vi.fn()) {
  server = new MobileClicker(() => ({ current: 3, total: 10, remaining: 7, canNavigate: true, timer: { text: '02:15', color: 'green' } }), command,
    () => ['127.0.0.1'], '127.0.0.1')
  const status = await server.setEnabled(true)
  const url = new URL(status.urls[0])
  return { base: url.origin, key: new URLSearchParams(url.hash.slice(1)).get('key')!, status }
}
describe('mobile clicker capability server', () => {
  it('serves a local page/QR and requires its own key for state or commands', async () => {
    const { base, key, status } = await start()
    expect(status.qr).toMatch(/^data:image\/png;base64,/)
    const page = await fetch(base)
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors')
    expect(await page.text()).not.toContain(key)
    expect((await fetch(base + '/state')).status).toBe(401)
    const state = await fetch(base + '/state', { headers: { authorization: 'Bearer ' + key } })
    expect(await state.json()).toEqual({ enabled: true, current: 3, total: 10, remaining: 7, canNavigate: true, timer: { text: '02:15', color: 'green' } })
    expect((await fetch(base + '/api/state', { headers: { authorization: 'Bearer ' + key } })).status).toBe(404)
  })
  it('accepts only next/prev, rejects foreign origins and executes a duplicate ID once', async () => {
    const command = vi.fn(); const { base, key } = await start(command)
    const post = (direction: string, id: string, origin?: string) => fetch(base + '/command', { method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ direction, id }) })
    expect((await post('take', 'bad')).status).toBe(400)
    for (const body of ['null', '[]', JSON.stringify({ direction: ['next'], id: 'array' })])
      expect((await fetch(base + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body })).status).toBe(400)
    expect((await post('next', 'foreign', 'http://example.com')).status).toBe(403)
    expect((await post('next', 'tap1')).status).toBe(200)
    expect((await post('next', 'tap1')).status).toBe(200)
    expect((await post('prev', 'tap2')).status).toBe(200)
    expect(command.mock.calls).toEqual([['next'], ['prev']])
  })
  it('pauses with the same link, resumes, and revokes only on explicit reset', async () => {
    const command = vi.fn(); const { base, key, status } = await start(command)
    const headers = { authorization: 'Bearer ' + key }
    await server!.setEnabled(false)
    expect(server!.status()).toMatchObject({ enabled: false, urls: status.urls })
    expect(await (await fetch(base + '/state', { headers })).json()).toMatchObject({ enabled: false })
    const post = () => fetch(base + '/command', { method: 'POST', headers, body: JSON.stringify({ direction: 'next', id: Math.random().toString(36).slice(2) }) })
    expect((await post()).ok).toBe(false)
    expect(command).not.toHaveBeenCalled()
    expect((await server!.setEnabled(true)).urls).toEqual(status.urls)
    expect((await post()).ok).toBe(true)
    expect(command).toHaveBeenCalledOnce()
    const current = await server!.resetLink()
    expect(new URL(current.urls[0]).origin).toBe(base)
    expect(current.urls[0]).not.toContain(key)
    expect((await fetch(base + '/state', { headers })).status).toBe(401)
    await Promise.all([server!.setEnabled(false), server!.setEnabled(true), server!.setEnabled(false)])
    expect(server!.status().enabled).toBe(false)
  })
  it('rejects navigation on the server when the current material cannot be paged', async () => {
    const command = vi.fn()
    server = new MobileClicker(() => ({ current: 1, total: 1, remaining: 0, canNavigate: false, timer: { text: '00:00', color: 'neutral' } }), command, () => ['127.0.0.1'], '127.0.0.1')
    const status = await server.setEnabled(true)
    const url = new URL(status.urls[0]); const key = new URLSearchParams(url.hash.slice(1)).get('key')!
    const response = await fetch(url.origin + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify({ direction: 'next', id: 'blocked' }) })
    expect(response.ok).toBe(false)
    expect(command).not.toHaveBeenCalled()
  })
  it('keeps the exact URL and enabled state across process recreation, rotating only explicitly', async () => {
    let saved: import('../src/main/mobile-clicker-storage').MobileClickerRecord | null = null
    const storage = { load: async () => saved && { ...saved }, save: async (record: import('../src/main/mobile-clicker-storage').MobileClickerRecord) => { saved = { ...record } } }
    const create = () => new MobileClicker(() => ({ current: 1, total: 3, remaining: 2, canNavigate: true, timer: { text: '00:00', color: 'neutral' } }), vi.fn(), () => ['127.0.0.1'], '127.0.0.1', storage)
    server = create()
    const original = await server.setEnabled(true)
    await server.dispose()
    server = create()
    expect(await server.setEnabled()).toMatchObject({ enabled: true, urls: original.urls })
    await server.setEnabled(false)
    await server.dispose()
    server = create()
    expect(await server.setEnabled()).toMatchObject({ enabled: false, urls: original.urls })
    const rotated = await server.resetLink()
    expect(rotated.urls).not.toEqual(original.urls)
    await server.dispose()
    server = create()
    expect(await server.setEnabled()).toMatchObject({ enabled: false, urls: rotated.urls })
  })
  it('does not replace a saved link if its port is occupied or saving a reset fails', async () => {
    const { createServer } = await import('node:http')
    const occupied = createServer()
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const port = (occupied.address() as import('node:net').AddressInfo).port
    const key = 'a'.repeat(43)
    const save = vi.fn()
    server = new MobileClicker(() => ({ current: 1, total: 3, remaining: 2, canNavigate: true, timer: { text: '00:00', color: 'neutral' } }), vi.fn(), () => ['127.0.0.1'], '127.0.0.1', { load: async () => ({ key, port, enabled: true }), save })
    try { expect(await server.setEnabled()).toMatchObject({ enabled: false, error: 'Не удалось запустить мобильный кликер' }); expect(save).not.toHaveBeenCalled() }
    finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
    const status = await server.setEnabled(true)
    expect(status.urls[0]).toBe('http://127.0.0.1:' + port + '/#key=' + key)
    save.mockRejectedValueOnce(Error('Disk full'))
    await expect(server.resetLink()).rejects.toThrow('Disk full')
    expect(server.status().urls).toEqual(status.urls)
  })
  it('does not generate or save a replacement when stored credentials cannot be read', async () => {
    const save = vi.fn()
    server = new MobileClicker(() => ({ current: 0, total: 0, remaining: 0, canNavigate: false, timer: { text: '00:00', color: 'neutral' } }), vi.fn(), () => ['127.0.0.1'], '127.0.0.1', { load: async () => { throw Error('Unreadable credential') }, save })
    await expect(server.setEnabled()).rejects.toThrow('Unreadable credential')
    expect(save).not.toHaveBeenCalled()
    expect(server.status().urls).toEqual([])
  })
  it('rejects oversized bodies and reports missing network addresses', async () => {
    const command = vi.fn(); const { base, key } = await start(command)
    expect((await fetch(base + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: 'x'.repeat(2100) })).status).toBe(413)
    expect(command).not.toHaveBeenCalled()
    await server!.dispose()
    server = new MobileClicker(() => ({ current: 0, total: 0, remaining: 0, canNavigate: false, timer: { text: '00:00', color: 'red' } }), command, () => [], '127.0.0.1')
    expect(await server.setEnabled(true)).toMatchObject({ enabled: true, urls: [], qr: null, error: 'Нет адреса локальной сети' })
  })
})
