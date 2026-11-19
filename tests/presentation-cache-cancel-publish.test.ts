import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PresentationCache, versionName, type PublishInput } from '../src/main/presentation-preparation-cache'
import type { SourceIdentity } from '../src/shared/presentation-preparation'

const sha1 = 'a'.repeat(40)
const identity: SourceIdentity = { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' }
let root: string
let cache: PresentationCache
let registered: string[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cuedeck-cancel-publish-'))
  registered = []
  cache = new PresentationCache({ cacheRoot: root, registerRoot: (_sha, path) => { registered.push(path) } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function input(generation: number, body: string): Promise<PublishInput> {
  const stage = await cache.stageDir(`job-${generation}`)
  const artifactsDir = join(stage, 'artifacts')
  await mkdir(artifactsDir)
  await writeFile(join(artifactsDir, `${sha1}.pdf`), body)
  return {
    artifactsDir, sha1, generation, sourcePath: join(root, 'deck.pptx'), identity,
    totalSlides: 1, slideMedia: [], pageNotes: {}, fonts: [], hasManifest: false,
  }
}

it('removes only its new root when cancelled during post-rename validation', async () => {
  const previous = await cache.publish(await input(1, '%PDF previous'))
  const indexPath = join(cache.preparedRoot, 'index.json')
  const previousIndex = await readFile(indexPath, 'utf8')
  const pending = await input(2, '%PDF cancelled')
  let cancel = false
  let entered!: () => void
  let resume!: () => void
  const atValidation = new Promise<void>(resolve => { entered = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  const originalValidRoot = cache.validRoot.bind(cache)
  cache.validRoot = async (sha, generation) => {
    if (generation === 2) { entered(); await release }
    return originalValidRoot(sha, generation)
  }

  const publishing = cache.publish({ ...pending, commitGuard: () => !cancel })
  await atValidation
  cancel = true
  resume()
  await expect(publishing).rejects.toThrow('stale generation')

  expect(existsSync(join(cache.preparedRoot, sha1, versionName(2)))).toBe(false)
  expect(await readFile(previous.pdfPath, 'utf8')).toBe('%PDF previous')
  expect(await readFile(indexPath, 'utf8')).toBe(previousIndex)
  expect(registered).toEqual([previous.cacheRoot])
  expect((await cache.lookupBySha(sha1))?.pdfPath).toBe(previous.pdfPath)
})

it('does not move or remove a stage if cancellation lands while loading the index', async () => {
  const pending = await input(3, '%PDF staged')
  let cancel = false
  let entered!: () => void
  let resume!: () => void
  const atIndex = new Promise<void>(resolve => { entered = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  const indexAccess = cache as unknown as { ensureIndex: () => Promise<void> }
  const originalEnsureIndex = indexAccess.ensureIndex.bind(cache)
  indexAccess.ensureIndex = async () => { await originalEnsureIndex(); entered(); await release }

  const publishing = cache.publish({ ...pending, commitGuard: () => !cancel })
  await atIndex
  cancel = true
  resume()
  await expect(publishing).rejects.toThrow('stale generation')
  expect(await readFile(join(pending.artifactsDir, `${sha1}.pdf`), 'utf8')).toBe('%PDF staged')
  expect(existsSync(join(cache.preparedRoot, sha1, versionName(3)))).toBe(false)
  expect(registered).toEqual([])
})

it('never removes an existing generation when its rename cannot proceed', async () => {
  const previous = await cache.publish(await input(4, '%PDF previous'))
  const collision = await input(4, '%PDF collision')
  await expect(cache.publish(collision)).rejects.toThrow('generation already exists')
  expect(await readFile(previous.pdfPath, 'utf8')).toBe('%PDF previous')
  expect(await readFile(join(collision.artifactsDir, `${sha1}.pdf`), 'utf8')).toBe('%PDF collision')
})
