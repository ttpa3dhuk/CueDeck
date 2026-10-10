import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ userData: '', spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => runtime.userData } }))
vi.mock('node:child_process', () => ({ spawn: runtime.spawn }))
vi.mock('../src/main/diag', () => ({ log: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/display-mapping', () => ({ getSofficePath: () => null, setSofficePath: vi.fn() }))

import { exportProjectCache, forgetProjectCache, localPptxCacheDir, pptxReadCacheDir, useProjectCache } from '../src/main/project-cache'
import { cachedPdfPathFor, convertPptxToPdf } from '../src/main/pptx-converter'
import { mediaDirFor, preparePptxMedia } from '../src/main/pptx-media'
import { loadProjectFile, saveProjectFile } from '../src/main/project'

const sourceBytes = Buffer.from('original presentation bytes')
const sha = createHash('sha1').update(sourceBytes).digest('hex')
const manifest = {
  version: 5, rebuilt: true, fonts: ['Example Sans'], pageNotes: { 2: 'Notes for animation step', 3: 'More notes' },
  slideMedia: [{ slide: 4, file: 'media1.mp4', rect: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } }],
}
let dir: string
let projectDir: string
let source: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-project-cache-'))
  projectDir = join(dir, 'show')
  runtime.userData = join(dir, 'primary-user')
  runtime.spawn.mockReset()
  forgetProjectCache(sha)
  await mkdir(join(projectDir, 'materials'), { recursive: true })
  source = join(projectDir, 'materials', 'deck.pptx')
  await writeFile(source, sourceBytes)
  await mkdir(join(localPptxCacheDir(), `${sha}.media`), { recursive: true })
  await writeFile(join(localPptxCacheDir(), `${sha}.pdf`), '%PDF-1.7 ready animation pages')
  await writeFile(join(localPptxCacheDir(), `${sha}.media.json`), JSON.stringify(manifest))
  await writeFile(join(localPptxCacheDir(), `${sha}.media`, 'media1.mp4'), 'embedded video')
})
afterEach(async () => {
  forgetProjectCache(sha)
  await rm(dir, { recursive: true, force: true })
})

describe('project on a flash drive', () => {
  it('moves the complete project to a clean machine and opens PDF, notes and video without LibreOffice', async () => {
    await saveProjectFile(join(projectDir, 'show.pdpres'), {
      playlist: [{ id: 'deck', kind: 'pptx', filePath: source, fileName: 'deck.pptx', displayName: '', speakerName: '', durationMs: 60000 }],
      keyVisualPath: null,
    })
    await exportProjectCache(sha, source, projectDir)
    const moved = join(dir, 'flash', 'show')
    await cp(projectDir, moved, { recursive: true })
    await rm(projectDir, { recursive: true })
    runtime.userData = join(dir, 'backup-user')
    const loaded = await loadProjectFile(join(moved, 'show.pdpres'))
    const movedSource = loaded.playlist[0].filePath
    const actualSha = createHash('sha1').update(await readFile(movedSource)).digest('hex')
    expect(await useProjectCache(actualSha, movedSource, join(moved, 'show.pdpres'))).toBe(true)
    const prepared = await preparePptxMedia(movedSource, actualSha)
    expect(prepared.temporary).toBe(false)
    expect(prepared.pageNotes).toEqual(manifest.pageNotes)
    expect(prepared.slideMedia).toEqual(manifest.slideMedia)
    const pdf = await convertPptxToPdf(prepared.convertSource, actualSha)
    expect(await readFile(pdf, 'utf8')).toBe('%PDF-1.7 ready animation pages')
    expect(await readFile(join(mediaDirFor(actualSha), 'media1.mp4'), 'utf8')).toBe('embedded video')
    expect(runtime.spawn).not.toHaveBeenCalled()
    expect(existsSync(runtime.userData)).toBe(false)
    expect(pdf).toBe(join(moved, 'pptx-cache', `${sha}.pdf`))
  })

  it('exports only the deck artifacts, with no temporary rebuilt PPTX or unrelated cache', async () => {
    await writeFile(join(localPptxCacheDir(), `${sha}.rebuilt.pptx`), 'temporary')
    await writeFile(join(localPptxCacheDir(), 'other.pdf'), 'unrelated')
    await exportProjectCache(sha, source, projectDir)
    expect((await readdir(join(projectDir, 'pptx-cache'))).sort()).toEqual([`${sha}.media`, `${sha}.media.json`, `${sha}.pdf`].sort())
    expect(await readFile(join(localPptxCacheDir(), 'other.pdf'), 'utf8')).toBe('unrelated')
  })

  it('allows another export from a portable cache with no local cache', async () => {
    await exportProjectCache(sha, source, projectDir)
    runtime.userData = join(dir, 'backup-user')
    await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))
    const second = join(dir, 'second-project')
    await exportProjectCache(sha, source, second)
    expect(await readFile(join(second, 'pptx-cache', `${sha}.pdf`), 'utf8')).toBe('%PDF-1.7 ready animation pages')
  })

  it('does not accept an unchanged-name presentation with changed bytes', async () => {
    await exportProjectCache(sha, source, projectDir)
    runtime.userData = join(dir, 'backup-user')
    await writeFile(source, 'updated deck')
    const changed = createHash('sha1').update(await readFile(source)).digest('hex')
    expect(await useProjectCache(changed, source, join(projectDir, 'show.pdpres'))).toBe(false)
  })

  it.each(['video', 'pdf', 'manifest', 'version', 'unsafe-name'])('rejects an incomplete or incompatible bundle: %s', async (broken) => {
    await exportProjectCache(sha, source, projectDir)
    const cache = join(projectDir, 'pptx-cache')
    if (broken === 'video') await rm(join(cache, `${sha}.media`, 'media1.mp4'))
    if (broken === 'pdf') await rm(join(cache, `${sha}.pdf`))
    if (broken === 'manifest') await writeFile(join(cache, `${sha}.media.json`), '{broken')
    if (broken === 'version') await writeFile(join(cache, `${sha}.media.json`), JSON.stringify({ ...manifest, version: 999 }))
    if (broken === 'unsafe-name') await writeFile(join(cache, `${sha}.media.json`), JSON.stringify({ ...manifest, slideMedia: [{ ...manifest.slideMedia[0], file: '..\\outside.mp4' }] }))
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))).toBe(false)
    expect(cachedPdfPathFor(sha)).toBe(join(localPptxCacheDir(), `${sha}.pdf`))
  })

  it('rejects a video folder symlink instead of following it outside the cache', async () => {
    await exportProjectCache(sha, source, projectDir)
    const cache = join(projectDir, 'pptx-cache')
    await rm(join(cache, `${sha}.media`), { recursive: true })
    await symlink(join(localPptxCacheDir(), `${sha}.media`), join(cache, `${sha}.media`))
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))).toBe(false)
  })

  it('does not use a neighboring project cache for an external material', async () => {
    await exportProjectCache(sha, source, projectDir)
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, join(dir, 'outside.pptx'), join(projectDir, 'show.pdpres'))).toBe(false)
  })

  it('keeps the original local cache when the project copy is available', async () => {
    await exportProjectCache(sha, source, projectDir)
    expect(await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))).toBe(false)
    expect(cachedPdfPathFor(sha)).toBe(join(localPptxCacheDir(), `${sha}.pdf`))
  })

  it('can detach a portable PDF for an explicit local rebuild without deleting the flash-drive copy', async () => {
    await exportProjectCache(sha, source, projectDir)
    runtime.userData = join(dir, 'backup-user')
    await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))
    forgetProjectCache(sha)
    expect(cachedPdfPathFor(sha)).toBe(join(localPptxCacheDir(), `${sha}.pdf`))
    expect(existsSync(join(projectDir, 'pptx-cache', `${sha}.pdf`))).toBe(true)
  })

  it('also carries a converted ODP without a PPTX media manifest', async () => {
    const odp = join(projectDir, 'materials', 'deck.odp')
    await exportProjectCache(sha, odp, projectDir)
    expect(await readdir(join(projectDir, 'pptx-cache'))).toEqual([`${sha}.pdf`])
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, odp, join(projectDir, 'show.pdpres'))).toBe(true)
    await convertPptxToPdf(odp, sha)
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('reports incomplete cache instead of claiming that a backup project is ready', async () => {
    await rm(join(localPptxCacheDir(), `${sha}.media`, 'media1.mp4'))
    await expect(exportProjectCache(sha, source, projectDir)).rejects.toThrow()
    expect(existsSync(join(projectDir, 'pptx-cache', `${sha}.pdf`))).toBe(false)
  })
})
