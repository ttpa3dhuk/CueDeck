import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileClicker } from '../src/main/mobile-clicker'
import type { MobileClickerSnapshot } from '../src/shared/mobile-clicker'

let server: MobileClicker
afterEach(async () => { await server?.dispose() })
async function setup() {
  let presentationId = 'deck-a'
  const snapshot = (): MobileClickerSnapshot => ({ presentationId, current: 2, total: 10, remaining: 8, canNavigate: true, timer: { text: '02:00', color: 'green' } })
  const command = vi.fn()
  server = new MobileClicker(snapshot, command, () => ['127.0.0.1'], '127.0.0.1')
  const status = await server.setEnabled(true)
  const base = new URL(status.urls[0]).origin
  const key = new URLSearchParams(new URL(status.urls[0]).hash.slice(1)).get('key')!
  const access = await server.createGrant('Speaker', ['deck-a'])
  const grant = access.grants![0]
  const invite = await server.invitation(grant.id)
  const headers = { authorization: 'Bearer ' + new URLSearchParams(new URL(invite.url).hash.slice(1)).get('key'), 'x-clicker-client': 'device-123456789012345' }
  const state = async (extra = {}) => (await fetch(base + '/state', { headers: { ...headers, ...extra } })).json()
  const post = (id: string, extra = {}) => fetch(base + '/command', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ id, direction: 'next' }) })
  const approve = async () => { await state(); server.blockClient(server.status().clients![0].id, false) }
  return { base, key, grant, headers, state, post, approve, command, setDeck: (id: string) => { presentationId = id } }
}
describe('presentation capabilities and admission', () => {
  it('creates a scoped link with an empty display name without widening its permissions', async () => {
    await setup()
    const status = await server.createGrant('', ['deck-a'])
    expect(status.grants!.at(-1)).toMatchObject({ presentations: ['deck-a'] })
    expect(status.grants!.at(-1)!.name.trim().length).toBeGreaterThan(0)
  })
  it('distinguishes an empty presentation selection from the actual grant limit', async () => {
    await setup()
    let selectionError = ''
    try { await server.createGrant('Speaker', []) } catch (error) { selectionError = String(error) }
    expect(selectionError).not.toContain('64')
    expect(server.status().grants).toHaveLength(1)
    for (let i = 1; i < 64; i++) await server.createGrant('Speaker ' + i, ['deck-a'])
    await expect(server.createGrant('Speaker', ['deck-a'])).rejects.toThrow('64')
    expect(server.status().grants).toHaveLength(64)
  })
  it('requires operator admission and enforces presentation scope without leaking another deck state', async () => {
    const ctx = await setup()
    expect(await ctx.state()).toMatchObject({ enabled: false, total: 0, canNavigate: false })
    expect((await ctx.post('pending')).status).toBe(403)
    await ctx.approve()
    expect(await ctx.state()).toMatchObject({ enabled: true, total: 10 })
    expect((await ctx.post('allowed')).status).toBe(200)
    ctx.setDeck('deck-b')
    expect(await ctx.state()).toMatchObject({ enabled: false, total: 0, timer: { text: '--:--' } })
    expect((await ctx.post('forbidden')).status).toBe(403)
    expect(ctx.command).toHaveBeenCalledOnce()
    ctx.setDeck('deck-a')
    expect(await ctx.state()).toMatchObject({ enabled: true })
  })
  it('does not let changing a browser identifier bypass operator blocking', async () => {
    const ctx = await setup(); await ctx.approve()
    server.blockClient(server.status().clients![0].id, true)
    const other = { 'x-clicker-client': 'device-987654321012345' }
    expect((await ctx.post('blocked')).status).toBe(403)
    expect((await ctx.post('new-device', other)).status).toBe(403)
    expect(ctx.command).not.toHaveBeenCalled()
  })
  it('applies edited permissions immediately to an approved device without replacing its link', async () => {
    const ctx = await setup(); await ctx.approve()
    const original = await server.invitation(ctx.grant.id)
    await server.updateGrant(ctx.grant.id, ['deck-b'])
    expect((await ctx.post('removed')).status).toBe(403)
    ctx.setDeck('deck-b')
    expect((await ctx.post('added')).status).toBe(200)
    expect((await server.invitation(ctx.grant.id)).url).toBe(original.url)
    await expect(server.updateGrant(ctx.grant.id, [])).rejects.toThrow()
  })
  it('keeps the page online while paused, revokes links, and invalidates every grant on reset', async () => {
    const ctx = await setup(); await ctx.approve()
    await server.setEnabled(false)
    expect((await fetch(ctx.base)).status).toBe(200)
    expect((await ctx.post('paused')).status).toBe(403)
    await server.setEnabled(true)
    await server.revokeGrant(ctx.grant.id)
    expect((await fetch(ctx.base + '/state', { headers: ctx.headers })).status).toBe(401)
    await server.createGrant('All', null)
    await server.resetLink()
    expect(server.status().grants).toEqual([])
  })
  it('only enables the separate loopback CLOUDPUB endpoint explicitly and requires scoped credentials there', async () => {
    const ctx = await setup()
    const target = server.status().target!
    expect((await fetch(target)).status).toBe(403)
    await expect(server.configure(true, 'http://example.cloudpub.ru')).rejects.toThrow()
    await expect(server.configure(true, 'https://example.cloudpub.ru/path')).rejects.toThrow()
    await server.configure(true, 'https://example.cloudpub.ru')
    expect((await fetch(target)).status).toBe(200)
    expect((await fetch(target + '/state', { headers: { authorization: 'Bearer ' + ctx.key } })).status).toBe(401)
    expect((await fetch(target + '/state', { headers: { ...ctx.headers, origin: 'https://attacker.example' } })).status).toBe(403)
    const response = await fetch(target + '/state', { headers: { ...ctx.headers, origin: 'https://example.cloudpub.ru' } })
    expect(response.status).toBe(200)
    const invitation = await server.invitation(ctx.grant.id)
    expect(invitation.url).toMatch(/^https:\/\/example.cloudpub.ru\/#key=/)
    await server.configure(false, 'https://example.cloudpub.ru')
    expect((await fetch(target)).status).toBe(403)
  })
  it('bounds request floods and command execution with no queued clicks', async () => {
    const ctx = await setup(); await ctx.approve()
    const responses = await Promise.allSettled(Array.from({ length: 150 }, () => fetch(ctx.base + '/state', { headers: ctx.headers })))
    expect(responses.some(r => r.status === 'fulfilled' && r.value.status === 429)).toBe(true)
    expect(ctx.command).not.toHaveBeenCalled()
    expect(server.status().clients).toHaveLength(1)
  })
  it('rejects concurrent commands while one is running and never replays a timed out command', async () => {
    const ctx = await setup(); await ctx.approve()
    let finish!: () => void
    ctx.command.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const first = ctx.post('first')
    await vi.waitFor(() => expect(ctx.command).toHaveBeenCalledOnce())
    expect((await ctx.post('second')).status).toBe(429)
    finish(); expect((await first).status).toBe(200)
    expect((await ctx.post('first')).status).toBe(200)
    expect(ctx.command).toHaveBeenCalledOnce()
  })
  it('rechecks permissions after receiving a partial command body', async () => {
    const ctx = await setup(); await ctx.approve()
    const { request } = await import('node:http')
    let upload!: import('node:http').ClientRequest
    const result = new Promise<number>(resolve => {
      upload = request(ctx.base + '/command', { method: 'POST', headers: ctx.headers }, response => { response.resume(); resolve(response.statusCode!) })
      upload.write('{"direction":"next",')
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    await server.updateGrant(ctx.grant.id, ['deck-b'])
    upload.end('"id":"late-command"}')
    expect(await result).toBe(403)
    expect(ctx.command).not.toHaveBeenCalled()
  })
  it('counts body bytes rather than characters and rejects before command execution', async () => {
    const ctx = await setup(); await ctx.approve()
    const response = await fetch(ctx.base + '/command', { method: 'POST', headers: ctx.headers, body: JSON.stringify({ direction: 'next', id: 'unicode', extra: '€'.repeat(800) }) })
    expect(response.status).toBe(413)
    expect(ctx.command).not.toHaveBeenCalled()
  })
  it('closes online access and pauses commands even when saving settings fails', async () => {
    const save = vi.fn(async () => undefined)
    server = new MobileClicker(() => ({ current: 1, total: 2, remaining: 1, canNavigate: true, timer: { text: '00:00', color: 'neutral' } }), vi.fn(), () => ['127.0.0.1'], '127.0.0.1', { load: async () => null, save })
    await server.setEnabled(true)
    await server.configure(true, 'https://test.cloudpub.ru')
    const target = server.status().target!
    save.mockRejectedValueOnce(Error('Disk full'))
    await expect(server.configure(false, '')).rejects.toThrow('Disk full')
    expect((await fetch(target)).status).toBe(403)
    save.mockRejectedValueOnce(Error('Disk full'))
    await expect(server.setEnabled(false)).rejects.toThrow('Disk full')
    expect(server.status().enabled).toBe(false)
  })
})
