import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileClicker } from '../src/main/mobile-clicker'

let server: MobileClicker
afterEach(async () => { vi.restoreAllMocks(); await server?.dispose() })
async function setup() {
  let deck = 'deck-a'
  const command = vi.fn()
  const save = vi.fn(async () => undefined)
  server = new MobileClicker(() => ({ presentationId: deck, current: 1, total: 3, remaining: 2, canNavigate: true, timer: { text: '01:00', color: 'green' } }), command, () => ['127.0.0.1'], '127.0.0.1', { load: async () => null, save })
  await server.setEnabled(true)
  await server.configure(true, 'https://speaker.cloudpub.ru')
  const target = server.status().target!
  const headers = { origin: 'https://speaker.cloudpub.ru', 'x-clicker-client': 'visitor-123456789012345' }
  const join = (name = 'Guest') => fetch(target + '/join', { method: 'POST', headers, body: JSON.stringify({ name }) })
  const start = async () => {
    const response = await join(); expect(response.status).toBe(200)
    const { key } = await response.json()
    const auth = { ...headers, authorization: 'Bearer ' + key }
    const client = server.status().clients![0]
    const state = async () => (await fetch(target + '/state', { headers: auth })).json()
    const post = (id: string) => fetch(target + '/command', { method: 'POST', headers: auth, body: JSON.stringify({ id, direction: 'next' }) })
    return { auth, client, state, post }
  }
  return { target, headers, join, start, command, save, setDeck: (value: string) => { deck = value } }
}

describe('general CLOUDPUB address admission', () => {
  it('allows every guest in explicitly open mode but never bypasses the master pause', async () => {
    const ctx = await setup()
    await server.setGuestAccess(true, null)
    const visitor = await ctx.start()
    expect(await visitor.state()).toMatchObject({ enabled: true, canNavigate: true })
    expect((await visitor.post('open')).status).toBe(200)
    await server.setEnabled(false)
    expect((await visitor.post('paused-open')).status).toBe(403)
    expect(ctx.command).toHaveBeenCalledOnce()
    await server.setEnabled(true)
    await server.setGuestAccess(false, null)
    expect((await visitor.post('closed-guest-policy')).status).toBe(403)
  })
  it('enforces the presentation selection for automatically admitted guests and keeps manual blocks', async () => {
    const ctx = await setup()
    await server.setGuestAccess(true, ['deck-a'])
    const visitor = await ctx.start()
    ctx.setDeck('deck-b')
    expect(await visitor.state()).toMatchObject({ enabled: false, access: 'presentation', total: 0 })
    expect((await visitor.post('wrong-deck')).status).toBe(403)
    ctx.setDeck('deck-a')
    server.blockClient(visitor.client.id, true)
    await server.setGuestAccess(true, null)
    expect((await visitor.post('manually-blocked')).status).toBe(403)
    expect(ctx.command).not.toHaveBeenCalled()
  })
  it('does not expose application APIs, files, shell execution or remote enable controls', async () => {
    const ctx = await setup(); const visitor = await ctx.start()
    server.approveClient(visitor.client.id, null)
    for (const path of ['/api/state', '/status', '/enabled', '/guest-access', '/files', '/../package.json', '/%2e%2e/package.json', '/ipc', '/shell']) {
      expect((await fetch(ctx.target + path, { headers: visitor.auth })).status).toBe(404)
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
    for (const direction of ['exec', 'open', 'goto', 'setEnabled', 'shell']) {
      expect((await fetch(ctx.target + '/command', { method: 'POST', headers: visitor.auth, body: JSON.stringify({ direction, id: direction }) })).status).toBe(400)
    }
    expect(ctx.command).not.toHaveBeenCalled()
  })
  it('admits a visitor only after explicit operator approval with presentation permissions', async () => {
    const ctx = await setup(); const saved = ctx.save.mock.calls.length
    expect((await fetch(ctx.target)).status).toBe(200)
    const visitor = await ctx.start()
    expect(await visitor.state()).toMatchObject({ enabled: false, canNavigate: false, total: 0, access: 'approval' })
    expect((await visitor.post('pending')).status).toBe(403)
    expect(() => server.approveClient(visitor.client.id, [])).toThrow()
    server.approveClient(visitor.client.id, ['deck-a'])
    expect(await visitor.state()).toMatchObject({ enabled: true, canNavigate: true, total: 3 })
    expect((await visitor.post('approved')).status).toBe(200)
    ctx.setDeck('deck-b')
    expect(await visitor.state()).toMatchObject({ enabled: false, total: 0, access: 'presentation' })
    expect((await visitor.post('wrong-deck')).status).toBe(403)
    expect(ctx.command).toHaveBeenCalledOnce()
    expect(ctx.save).toHaveBeenCalledTimes(saved)
    expect(server.status().grants).toEqual([])
    expect((await fetch(ctx.target + '/state', { headers: { ...visitor.auth, 'x-clicker-client': 'different-device-1234567' } })).status).toBe(401)
    expect(server.status().clients).toHaveLength(1)
  })
  it('supports all presentations, pause, blocking and revocation without exposing a LAN credential', async () => {
    const ctx = await setup(); const visitor = await ctx.start()
    server.approveClient(visitor.client.id, null)
    ctx.setDeck('deck-b')
    expect(await visitor.state()).toMatchObject({ enabled: true })
    await server.setEnabled(false)
    expect((await fetch(ctx.target)).status).toBe(200)
    expect(await visitor.state()).toMatchObject({ enabled: false })
    expect((await visitor.post('paused')).status).toBe(403)
    await server.setEnabled(true)
    server.blockClient(visitor.client.id, true)
    expect((await visitor.post('blocked')).status).toBe(403)
    server.disconnectClient(visitor.client.id)
    expect((await fetch(ctx.target + '/state', { headers: visitor.auth })).status).toBe(401)
    expect(ctx.command).not.toHaveBeenCalled()
  })
  it('rejects foreign origins, invalid identity and oversized or invalid join bodies', async () => {
    const ctx = await setup()
    expect((await fetch(ctx.target + '/join', { method: 'POST', headers: { ...ctx.headers, origin: 'https://attacker.example' }, body: '{"name":"Guest"}' })).status).toBe(403)
    expect((await fetch(ctx.target + '/join', { method: 'POST', body: '{"name":"Guest"}' })).status).toBe(400)
    expect((await fetch(ctx.target + '/join', { method: 'POST', headers: ctx.headers, body: 'x'.repeat(513) })).status).toBe(413)
    expect((await fetch(ctx.target + '/join', { method: 'POST', headers: ctx.headers, body: 'null' })).status).toBe(400)
    expect(server.status().clients).toEqual([])
  })
  it('bounds anonymous request bursts independently of the normal clicker server', async () => {
    const ctx = await setup()
    for (let i = 0; i < 4; i++) expect((await ctx.join()).status).toBe(200)
    expect((await ctx.join()).status).toBe(429)
    expect(server.status().clients).toHaveLength(4)
    expect(server.status().grants).toEqual([])
    expect((await fetch(ctx.target)).status).toBe(200)
    expect(ctx.command).not.toHaveBeenCalled()
  })
  it('expires unapproved requests and limits the pending request table without disk writes', async () => {
    const ctx = await setup(); const baseTime = Date.now()
    const clock = vi.spyOn(Date, 'now')
    for (let i = 0; i < 16; i++) {
      clock.mockReturnValue(baseTime + i * 2000)
      expect((await ctx.join()).status).toBe(200)
    }
    clock.mockReturnValue(baseTime + 32000)
    expect((await ctx.join()).status).toBe(429)
    expect(server.status().clients).toHaveLength(16)
    clock.mockReturnValue(baseTime + 160000)
    expect(server.status().clients).toEqual([])
    expect((await ctx.join()).status).toBe(200)
    expect(ctx.save).toHaveBeenCalledTimes(2)
  })
})
