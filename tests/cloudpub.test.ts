import { describe, expect, it, vi } from 'vitest'
import { CloudpubTunnel, cloudpubEndpoints, clickerComputerName, type CloudpubRecord } from '../src/main/cloudpub'
const own = '11111111-1111-1111-1111-111111111111'
const other = '22222222-2222-2222-2222-222222222222'
const target = 'http://127.0.0.1:61234'
const remote = 'https://speaker.cloudpub.ru'
const name = clickerComputerName('qa-computer')
const branded = 'https://' + name + '.cloudpub.ru'
function fixture(saved: CloudpubRecord | null = null, existing = false) {
  let record = saved; let online = false; let created = Boolean(saved) || existing; let address = existing ? branded : remote
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'ls') return `online ${other} http://localhost:8080 -> https://other.cloudpub.ru\n` + (created ? `${online ? 'online' : 'offline'} ${own} [${name}] ${target} -> ${address}\n` : '')
    if (args[0] === 'register') { created = true; online = true }
    if (args[0] === 'start') online = true
    if (args[0] === 'stop') online = false
    return ''
  })
  const save = vi.fn(async (value: CloudpubRecord) => { record = value })
  const rename = vi.fn(async () => { address = branded; return branded })
  const tunnel = new CloudpubTunnel({ load: async () => record, save }, run, async () => '/installed/cloudpub.exe', () => name, rename)
  return { tunnel, run, save, stored: () => record }
}
describe('automatic Cloudpub publication', () => {
  it('uses a stable DNS-safe code without including the computer name', () => {
    expect(clickerComputerName('private-pc')).toMatch(/^cuedeck-[a-f0-9]{10}$/)
    expect(clickerComputerName('private-pc')).toBe(clickerComputerName('private-pc'))
    expect(clickerComputerName('another-pc')).not.toBe(clickerComputerName('private-pc'))
  })
  it('parses only a loopback HTTP endpoint with an HTTPS origin and handles default TLS port', () => {
    expect(cloudpubEndpoints(`online ${own} [CueDeck Mobile Clicker] ${target}/ -> ${remote}`)[0]).toMatchObject({ id: own, target, publicUrl: remote })
    expect(cloudpubEndpoints(`online ${own} http://localhost:61234 -> https://speaker.cloudpub.ru:443`)).toEqual([{ id: own, target, publicUrl: remote, online: true, status: 'online' }])
    for (const line of [
      `online ${own} http://192.168.0.1:80 -> ${remote}`,
      `online ${own} ${target}/api -> ${remote}`,
      `online ${own} ${target} -> http://speaker.cloudpub.ru`,
      `online ${own} ${target} -> https://user:secret@speaker.cloudpub.ru`,
    ]) expect(cloudpubEndpoints(line)).toEqual([])
  })
  it('registers only the clicker, saves ownership and verifies the external route before success', async () => {
    const ctx = fixture(); const activate = vi.fn(async () => undefined)
    expect(await ctx.tunnel.connect(target, activate)).toBe(branded)
    expect(activate).toHaveBeenCalledWith(branded)
    expect(ctx.stored()).toMatchObject({ id: own, target, publicUrl: branded })
    expect(ctx.run.mock.calls.find(([, args]) => args[0] === 'register')?.[1]).toEqual(['register', 'http', target, '--name', name])
    await ctx.tunnel.stop()
    expect(ctx.run.mock.calls.filter(([, args]) => args[0] === 'stop').map(([, args]) => args[1])).toEqual([own, own])
    expect(ctx.run.mock.calls.some(([, args]) => ['run', 'clean', 'purge'].includes(args[0]))).toBe(false)
  })
  it('reuses the exact saved publication instead of creating a new public URL', async () => {
    const ctx = fixture({ id: own, target, publicUrl: remote, executable: '/installed/cloudpub.exe' })
    await ctx.tunnel.connect(target, async () => undefined)
    expect(ctx.run.mock.calls.some(([, args]) => args[0] === 'register')).toBe(false)
    expect(ctx.run.mock.calls.some(([, args]) => args[0] === 'start' && args[1] === own)).toBe(true)
  })
  it('migrates an old profile code to the hardware code without creating another publication', async () => {
    const ctx = fixture({ id: own, target, publicUrl: remote, executable: '/installed/cloudpub.exe', computerName: 'cuedeck-ffffffffff' })
    await ctx.tunnel.connect(target, async () => undefined)
    expect(ctx.stored()?.computerName).toBe(name)
    expect(ctx.stored()?.publicUrl).toBe(branded)
    expect(ctx.run.mock.calls.some(([, args]) => args[0] === 'register')).toBe(false)
  })
  it('recovers its named publication when local metadata is missing instead of registering a duplicate', async () => {
    const ctx = fixture(null, true)
    await ctx.tunnel.connect(target, async () => undefined)
    expect(ctx.stored()?.id).toBe(own)
    expect(ctx.run.mock.calls.some(([, args]) => args[0] === 'register')).toBe(false)
  })
  it('retargets a recovered publication after a local port change without registration', async () => {
    let port = '61230'; let online = false
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'ls') return `${online ? 'online' : 'offline'} ${own} [${name}] http://127.0.0.1:${port} -> ${branded}`
      if (args[0] === 'start') online = true
      if (args[0] === 'stop') online = false
      return ''
    })
    const save = vi.fn(async () => undefined)
    const rename = vi.fn(async () => { port = '61234'; return branded })
    const tunnel = new CloudpubTunnel({ load: async () => null, save }, run, async () => '/cloudpub', () => name, rename)
    await tunnel.connect(target, async () => undefined)
    expect(run.mock.calls.some(([, args]) => args[0] === 'register')).toBe(false)
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ id: own }), name, undefined, target)
  })
  it('does not automatically replace manual setup on the next application start', async () => {
    const ctx = fixture({ id: own, target, publicUrl: remote, executable: '/installed/cloudpub.exe' })
    expect(await ctx.tunnel.configured()).toBe(true)
    await ctx.tunnel.useManualMode()
    expect(await ctx.tunnel.configured()).toBe(false)
    await ctx.tunnel.connect(target, async () => undefined)
    expect(await ctx.tunnel.configured()).toBe(true)
  })
  it('stops its publication when the public handshake fails', async () => {
    const ctx = fixture()
    await expect(ctx.tunnel.connect(target, async () => { throw Error('wrong origin') })).rejects.toThrow('wrong origin')
    expect(ctx.run.mock.calls.some(([, args]) => args[0] === 'stop' && args[1] === own)).toBe(true)
  })
  it('does not stop another publication if its saved target no longer matches', async () => {
    const ctx = fixture({ id: other, target, publicUrl: remote, executable: '/installed/cloudpub.exe' })
    await expect(ctx.tunnel.connect(target, async () => undefined)).rejects.toThrow('cloudpub-ownership')
    await expect(ctx.tunnel.stop()).rejects.toThrow('cloudpub-ownership')
    expect(ctx.run.mock.calls.some(([, args]) => args[0] === 'stop')).toBe(false)
  })
  it('cleans up a registration whose acknowledgement timed out', async () => {
    const ctx = fixture(); const implementation = ctx.run.getMockImplementation()!
    ctx.run.mockImplementation(async (file, args) => { const output = await implementation(file, args); if (args[0] === 'register') throw Error('timeout'); return output })
    await expect(ctx.tunnel.connect(target, async () => undefined)).rejects.toThrow('timeout')
    expect(ctx.run.mock.calls.some(([, args]) => args[0] === 'stop' && args[1] === own)).toBe(true)
  })
})
