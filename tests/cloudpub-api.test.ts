import { describe, expect, it, vi } from 'vitest'
import { updateCloudpubHostname } from '../src/main/cloudpub-api'
const record = { id: '11111111-1111-1111-1111-111111111111', target: 'http://127.0.0.1:61234', executable: '/cloudpub', publicUrl: 'https://old.cloudpub.ru' }
const publication = { id: 123, guid: record.id, local_addr: '127.0.0.1', local_port: 61234, local_proto: 'HTTP', remote_addr: 'old.cloudpub.ru' }
describe('CLOUDPUB hostname assignment', () => {
  it('rejects a changed publication agent before mutation', async () => {
    const api = vi.fn(async (path: string) => path.includes('?') ? { results: [{ ...publication, agent: { guid: 'agent-one' } }], next: null } : { ...publication, agent: { guid: 'agent-two' } })
    await expect(updateCloudpubHostname(record, 'cuedeck-012345abcd', api)).rejects.toThrow('cloudpub-ownership')
    expect(api.mock.calls).toHaveLength(2)
  })
  it('patches only the owned publication hostname and description, preserving access settings', async () => {
    const api = vi.fn(async (_path: string, method?: string) => method === 'PATCH' ? { remote_addr: 'cuedeck-012345abcd.cloudpub.ru' } : _path.includes('?') ? { results: [publication], next: null } : publication)
    expect(await updateCloudpubHostname(record, 'cuedeck-012345abcd', api)).toBe('https://cuedeck-012345abcd.cloudpub.ru')
    expect(api.mock.calls.at(-1)).toEqual(['/api/endpoint/publications/123/', 'PATCH', { remote_addr: 'cuedeck-012345abcd.cloudpub.ru', description: 'cuedeck-012345abcd' }])
  })
  it('does not modify a publication if ownership changed between the list and detail requests', async () => {
    const api = vi.fn(async (path: string) => path.includes('?') ? { results: [publication], next: null } : { ...publication, local_port: 8080 })
    await expect(updateCloudpubHostname(record, 'cuedeck-012345abcd', api)).rejects.toThrow('cloudpub-ownership')
    expect(api.mock.calls).toHaveLength(2)
  })
  it('can retarget the same verified publication without creating another one', async () => {
    const api = vi.fn(async (path: string, method?: string) => method === 'PATCH' ? { remote_addr: 'cuedeck-012345abcd.cloudpub.ru' } : path.includes('?') ? { results: [publication], next: null } : publication)
    await updateCloudpubHostname(record, 'cuedeck-012345abcd', api, 'http://127.0.0.1:61235')
    expect(api.mock.calls.at(-1)).toEqual(['/api/endpoint/publications/123/', 'PATCH', { remote_addr: 'cuedeck-012345abcd.cloudpub.ru', description: 'cuedeck-012345abcd', local_port: 61235 }])
  })
})
