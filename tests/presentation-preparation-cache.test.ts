import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => runtime.userData } }))

import {
  PREPARED_CACHE_FOLDER,
  PREPARED_METADATA_FILE,
  PPTX_MANIFEST_VERSION,
} from '../src/shared/presentation-preparation'
import { sourceIdentity } from '../src/main/presentation-preparation-core'
import { PresentationCache, versionName } from '../src/main/presentation-preparation-cache'
import {
  clearLocalCache,
  exportProjectCache,
  forgetPreparedRoot,
  isPreparedRootRetained,
  localCacheStats,
  localPptxCacheDir,
  pdfCachePath,
  preparedRootFor,
  pptxReadCacheDir,
  registerPreparedRoot,
  retainPreparedRoot,
  useProjectCache,
} from '../src/main/project-cache'
import { mediaDirFor } from '../src/main/pptx-media'

const MANIFEST = {
  version: PPTX_MANIFEST_VERSION,
  rebuilt: true,
  slideMedia: [{ slide: 1, file: 'clip.mp4', rect: { x: 0, y: 0, w: 1, h: 1 } }],
  pageNotes: { 1: 'speaker note' },
  fonts: ['Example Sans'],
}

let dir: string
let source: string
let sha: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-cache-'))
  runtime.userData = join(dir, 'user-data')
  source = join(dir, 'deck.pptx')
  await writeFile(source, 'original deck bytes')
  sha = createHash('sha1').update(await readFile(source)).digest('hex')
})

afterEach(async () => {
  forgetPreparedRoot(sha)
  await rm(dir, { recursive: true, force: true })
})

async function publish(cacheRoot: string, generation: number, pdfBody = '%PDF versioned'): Promise<Awaited<ReturnType<PresentationCache['publish']>>> {
  const cache = new PresentationCache({ cacheRoot, registerRoot: registerPreparedRoot })
  const stage = await cache.stageDir(`job-${generation}`)
  const artifacts = join(stage, 'artifacts')
  await mkdir(join(artifacts, `${sha}.media`), { recursive: true })
  await writeFile(join(artifacts, `${sha}.pdf`), pdfBody)
  await writeFile(join(artifacts, `${sha}.media.json`), JSON.stringify(MANIFEST))
  await writeFile(join(artifacts, `${sha}.media`, 'clip.mp4'), 'video bytes')
  const identity = await sourceIdentity(source)
  const result = await cache.publish({
    artifactsDir: artifacts,
    sha1: sha,
    generation,
    sourcePath: source,
    identity,
    totalSlides: 3,
    slideMedia: MANIFEST.slideMedia,
    pageNotes: MANIFEST.pageNotes,
    fonts: [],
    hasManifest: true,
  })
  await cache.discardStage(stage)
  return result
}

it('cleans only marked abandoned stages and leaves an unknown neighboring folder intact', async () => {
  const cache = new PresentationCache({ cacheRoot: localPptxCacheDir() })
  const owned = await cache.stageDir('expired')
  const neighbor = join(cache.stageRoot, 'user-folder')
  await mkdir(neighbor)
  await writeFile(join(neighbor, 'keep.txt'), 'keep')
  await cache.cleanupStages(-1)
  expect(existsSync(owned)).toBe(false)
  expect(await readFile(join(neighbor, 'keep.txt'), 'utf8')).toBe('keep')
})

describe('versioned presentation cache integration', () => {
  it('registers a published root for existing readers and keeps old generations intact', async () => {
    const first = await publish(localPptxCacheDir(), 10, '%PDF old root')
    expect(pptxReadCacheDir(sha)).toBe(first.cacheRoot)
    expect(pdfCachePath(localPptxCacheDir(), sha)).toBe(first.pdfPath)
    expect(preparedRootFor(sha)).toBe(first.cacheRoot)
    expect(mediaDirFor(sha)).toBe(join(first.cacheRoot, `${sha}.media`))
    expect(await readFile(join(mediaDirFor(sha), 'clip.mp4'), 'utf8')).toBe('video bytes')

    const second = await publish(localPptxCacheDir(), 20, '%PDF new root')
    expect(second.cacheRoot).not.toBe(first.cacheRoot)
    expect(pptxReadCacheDir(sha)).toBe(second.cacheRoot)
    expect(await readFile(join(first.cacheRoot, `${sha}.pdf`), 'utf8')).toBe('%PDF old root')
    expect(await readFile(join(first.cacheRoot, PREPARED_METADATA_FILE), 'utf8')).toContain('"generation":10')
    // Обе версии — целые папки, старые media не перезаписаны.
    expect(existsSync(join(first.cacheRoot, `${sha}.media`, 'clip.mp4'))).toBe(true)
    expect(existsSync(join(second.cacheRoot, `${sha}.media`, 'clip.mp4'))).toBe(true)
  })

  it('exports the newest prepared generation into a portable project cache', async () => {
    await publish(localPptxCacheDir(), 10, '%PDF old root')
    const newest = await publish(localPptxCacheDir(), 20, '%PDF portable root')
    const projectDir = join(dir, 'show')
    await mkdir(projectDir, { recursive: true })
    const projectSource = join(projectDir, 'deck.pptx')
    await writeFile(projectSource, 'original deck bytes')
    const files = await exportProjectCache(sha, projectSource, projectDir)
    expect(files.map((file) => file.target).sort()).toEqual([
      join(projectDir, 'pptx-cache', `${sha}.media`, 'clip.mp4'),
      join(projectDir, 'pptx-cache', `${sha}.media.json`),
      join(projectDir, 'pptx-cache', `${sha}.pdf`),
    ].sort())
    expect(await readFile(join(projectDir, 'pptx-cache', `${sha}.pdf`), 'utf8')).toBe('%PDF portable root')
    expect(existsSync(join(newest.cacheRoot, `${sha}.pdf`))).toBe(true)

    runtime.userData = join(dir, 'other-user-data')
    forgetPreparedRoot(sha)
    expect(await useProjectCache(sha, projectSource, join(projectDir, 'show.pdpres'))).toBe(true)
    expect(cachedPortableRoot(sha)).toBe(join(projectDir, 'pptx-cache'))
  })

  it('protects active hashes and explicit leases during clear, then removes new format', async () => {
    const first = await publish(localPptxCacheDir(), 10)
    const second = await publish(localPptxCacheDir(), 20)
    const stats = await localCacheStats(new Set([sha]))
    expect(stats.bytes).toBeGreaterThan(0)
    expect(stats.protectedBytes).toBeGreaterThan(0)

    const release = retainPreparedRoot(second.cacheRoot)
    const secondRelease = retainPreparedRoot(second.cacheRoot)
    release()
    release() // releasing the same lease twice must not consume another reader's lease
    expect(isPreparedRootRetained(second.cacheRoot)).toBe(true)
    const retainedClear = await clearLocalCache(new Set([sha]))
    expect(retainedClear.files).toBe(0)
    expect(existsSync(first.cacheRoot)).toBe(true)
    secondRelease()

    const cleared = await clearLocalCache(new Set())
    expect(cleared.files).toBeGreaterThan(0)
    expect(existsSync(first.cacheRoot)).toBe(false)
    expect(existsSync(second.cacheRoot)).toBe(false)
    expect(existsSync(join(localPptxCacheDir(), PREPARED_CACHE_FOLDER))).toBe(false)
    expect(preparedRootFor(sha)).toBeNull()
  })
})

/** project-cache уже знает pptxReadCacheDir; отдельный helper для читаемости теста. */
function cachedPortableRoot(value: string): string | null {
  const pdf = pdfCachePath(pptxReadCacheDir(value), value)
  if (!pdf) return null
  return dirname(pdf)
}
