import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, utimes, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SharedPdfRegistry } from '../src/main/shared-pdf-registry'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cuedeck-pdf-cap-')); roots.push(root)
  const a = { path: join(root, 'a.pdf'), sha1: 'a' }, b = { path: join(root, 'b.pdf'), sha1: 'b' }
  await writeFile(a.path, 'one'); await writeFile(b.path, 'two')
  return { registry: new SharedPdfRegistry(), a, b }
}
it('keeps the same immutable capabilities when Preview becomes Program', async () => {
  const { registry, a, b } = await fixture()
  const first = await registry.reconcile([a, b])
  const second = await registry.reconcile([b, a])
  expect(second.map(source => source.id)).toEqual(first.map(source => source.id).reverse())
  expect(registry.get(a)?.id).toBe(first[0].id)
  expect(await registry.resolve(new URL(first[0].file.url))).toBe(a.path)
  expect((await registry.reconcile([b, b])).length).toBe(1)
  expect(await registry.resolve(new URL(first[0].file.url))).toBeNull()
})
it('rejects source mutation and an invented capability', async () => {
  const { registry, a } = await fixture()
  const [source] = await registry.reconcile([a])
  await writeFile(a.path, 'new')
  await utimes(a.path, new Date(), new Date(Date.now() + 2000))
  expect(await registry.resolve(new URL(source.file.url))).toBeNull()
  await expect(registry.reconcile([a])).rejects.toThrow('changed on disk')
  expect(await registry.resolve(new URL(`cuedeck-media://pdf-source/${'0'.repeat(64)}`))).toBeNull()
  expect(await registry.resolve(new URL('cuedeck-media://pdf-source/../../etc/passwd'))).toBeNull()
})
it('a missing Preview does not remove the surviving Program', async () => {
  const { registry, a, b } = await fixture()
  await registry.reconcile([a, b])
  const program = registry.get(a)!
  await unlink(b.path)
  const failure = vi.fn()
  const sources = await registry.reconcile([a, b], failure)
  expect(failure).toHaveBeenCalledOnce()
  expect(sources).toEqual([program])
  expect(await registry.resolve(new URL(program.file.url))).toBe(a.path)
})
