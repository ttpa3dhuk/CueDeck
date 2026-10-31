import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ root: '', available: true, backend: 'gnome_libsecret' }))
vi.mock('electron', () => ({
  app: { getPath: () => runtime.root },
  safeStorage: {
    isEncryptionAvailable: () => runtime.available,
    getSelectedStorageBackend: () => runtime.backend,
    encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
    decryptString: (b: Buffer) => b.toString().split('').reverse().join(''),
  },
}))
beforeEach(async () => {
  runtime.root = await mkdtemp(join(tmpdir(), 'cuedeck-remote-key-'))
  runtime.available = true
  runtime.backend = 'gnome_libsecret'
  vi.resetModules()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(runtime.root, { recursive: true, force: true })
})

it('creates one stable encrypted key across concurrent calls and module restarts', async () => {
  const first = await import('../src/main/remote/access-key')
  const keys = await Promise.all([first.remoteAccessKey(), first.remoteAccessKey()])
  expect(keys[0]).toMatch(/^[a-f0-9]{64}$/)
  expect(keys[1]).toBe(keys[0])
  const disk = await readFile(join(runtime.root, 'remote-access-key.json'), 'utf8')
  expect(disk).not.toContain(keys[0])
  vi.resetModules()
  expect(await (await import('../src/main/remote/access-key')).remoteAccessKey()).toBe(keys[0])
  expect(await readFile(join(runtime.root, 'remote-access-key.json'), 'utf8')).toBe(disk)
})

it('does not replace a damaged existing key file or fall back to plaintext', async () => {
  const path = join(runtime.root, 'remote-access-key.json')
  await writeFile(path, 'damaged')
  const api = await import('../src/main/remote/access-key')
  await expect(api.remoteAccessKey()).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('damaged')
})

it('fails without encryption and permits a later retry when it is available', async () => {
  runtime.available = false
  const api = await import('../src/main/remote/access-key')
  await expect(api.remoteAccessKey()).rejects.toThrow('encryption unavailable')
  await expect(readFile(join(runtime.root, 'remote-access-key.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  runtime.available = true
  expect(await api.remoteAccessKey()).toMatch(/^[a-f0-9]{64}$/)
})

it('rejects Linux basic_text even when encryption reports available, then permits a secure retry', async () => {
  vi.stubGlobal('process', new Proxy(process, {
    get: (target, property) => property === 'platform' ? 'linux' : Reflect.get(target, property),
  }))
  runtime.backend = 'basic_text'
  const api = await import('../src/main/remote/access-key')
  await expect(api.remoteAccessKey()).rejects.toThrow('encryption unavailable')
  await expect(readFile(join(runtime.root, 'remote-access-key.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  runtime.backend = 'gnome_libsecret'
  expect(await api.remoteAccessKey()).toMatch(/^[a-f0-9]{64}$/)
})
