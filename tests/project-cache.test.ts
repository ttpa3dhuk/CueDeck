import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ userData: '', spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => runtime.userData } }))
vi.mock('node:child_process', () => ({ spawn: runtime.spawn }))
vi.mock('../src/main/diag', () => ({ log: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/display-mapping', () => ({ getSofficePath: () => null, setSofficePath: vi.fn() }))

import { PPTX_MANIFEST_VERSION, clearLocalCache, exportProjectCache, forgetProjectCache, localCacheStats, localPptxCacheDir, pptxReadCacheDir, useProjectCache } from '../src/main/project-cache'
import { cachedPdfPathFor, convertPptxToPdf, setManualSoffice } from '../src/main/pptx-converter'
import { mediaDirFor, preparePptxMedia } from '../src/main/pptx-media'
import { loadProjectFile, saveProjectFile } from '../src/main/project'

const sourceBytes = Buffer.from('original presentation bytes')
const sha = createHash('sha1').update(sourceBytes).digest('hex')
const manifest = {
  version: PPTX_MANIFEST_VERSION, rebuilt: true, fonts: ['Example Sans'], pageNotes: { 2: 'Notes for animation step', 3: 'More notes' },
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
  it('clears local generated files while preserving open decks, user files, and exported projects', async () => {
    const root = localPptxCacheDir()
    const other = createHash('sha1').update('corrected presentation').digest('hex')
    await mkdir(join(root, 'Conference'))
    await writeFile(join(root, 'Conference', `${other}.pdf`), 'new pdf')
    await mkdir(join(root, `${other}.media`))
    await writeFile(join(root, `${other}.media`, 'clip.mp4'), 'video bytes')
    await writeFile(join(root, `${other}.media.json`), 'manifest')
    await writeFile(join(root, 'keep.txt'), 'user file')
    await mkdir(join(runtime.userData, 'libreoffice-profile'))
    await writeFile(join(runtime.userData, 'libreoffice-profile', 'config.txt'), 'private profile')
    await exportProjectCache(sha, source, projectDir)

    const before = await localCacheStats(new Set([sha]))
    expect(before.bytes).toBeGreaterThan(before.protectedBytes)
    const cleared = await clearLocalCache(new Set([sha]))
    expect(cleared.bytes).toBeGreaterThan(0)
    expect(existsSync(join(root, 'Conference', `${other}.pdf`))).toBe(false)
    expect(existsSync(join(root, `${other}.media`))).toBe(false)
    expect(existsSync(join(root, `${sha}.pdf`))).toBe(true)
    expect(existsSync(join(root, 'keep.txt'))).toBe(true)
    expect(existsSync(join(projectDir, 'pptx-cache', `${sha}.pdf`))).toBe(true)
    expect(await readFile(join(runtime.userData, 'libreoffice-profile', 'config.txt'), 'utf8')).toBe('private profile')
    await clearLocalCache(new Set())
    expect(existsSync(join(root, `${sha}.pdf`))).toBe(false)
    expect(existsSync(join(root, 'keep.txt'))).toBe(true)
    expect(existsSync(join(projectDir, 'pptx-cache', `${sha}.pdf`))).toBe(true)
  })

  it('writes a new PDF with the original presentation name, even when LibreOffice reads a rebuilt copy', async () => {
    await rm(join(localPptxCacheDir(), `${sha}.pdf`))
    const rebuilt = join(dir, 'temporary.rebuilt.pptx')
    await writeFile(rebuilt, 'rebuilt copy')
    runtime.spawn.mockImplementation((_path: string, args: string[]) => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
      })
      if (args[0] === '--version') {
        queueMicrotask(() => {
          proc.stdout.emit('data', 'LibreOffice 26.2')
          proc.emit('close', 0)
        })
      } else {
        const out = args[args.indexOf('--outdir') + 1]
        void writeFile(join(out, `${parse(rebuilt).name}.pdf`), 'converted pdf')
          .then(() => proc.emit('close', 0), (err) => proc.emit('error', err))
      }
      return proc
    })
    await setManualSoffice(process.execPath)
    const pdf = await convertPptxToPdf(rebuilt, sha, source)
    expect(pdf).toBe(join(localPptxCacheDir(), 'deck', `${sha}.pdf`))
    expect(await readFile(pdf, 'utf8')).toBe('converted pdf')
    const conversionArgs = runtime.spawn.mock.calls.find(([, args]) => args.includes('--convert-to'))?.[1] as string[]
    expect(conversionArgs).toContain(`-env:UserInstallation=${pathToFileURL(join(runtime.userData, 'libreoffice-profile')).href}`)
    const filter = conversionArgs[conversionArgs.indexOf('--convert-to') + 1]
    expect(filter).toMatch(/^pdf:impress_pdf_Export:/)
    expect(JSON.parse(filter.slice('pdf:impress_pdf_Export:'.length))).toMatchObject({
      ExportHiddenSlides: { value: 'false' },
      ExportNotesPages: { value: 'false' },
      ExportNotes: { value: 'false' },
      ReduceImageResolution: { value: 'false' },
    })
    const correctedSha = createHash('sha1').update('corrected presentation bytes').digest('hex')
    const correctedPdf = await convertPptxToPdf(rebuilt, correctedSha, source)
    expect(correctedPdf).toBe(join(localPptxCacheDir(), 'deck', `${correctedSha}.pdf`))
    expect(existsSync(pdf)).toBe(true)
  })

  it('keeps a readable PDF name in new caches and portable projects', async () => {
    const local = localPptxCacheDir()
    await mkdir(join(local, 'deck'))
    await rename(join(local, `${sha}.pdf`), join(local, 'deck', `${sha}.pdf`))
    expect(cachedPdfPathFor(sha)).toBe(join(local, 'deck', `${sha}.pdf`))

    await exportProjectCache(sha, source, projectDir)
    expect(await readFile(join(projectDir, 'pptx-cache', 'deck', `${sha}.pdf`), 'utf8')).toBe('%PDF-1.7 ready animation pages')
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))).toBe(true)
    expect(cachedPdfPathFor(sha)).toBe(join(projectDir, 'pptx-cache', 'deck', `${sha}.pdf`))
    expect(await convertPptxToPdf(source, sha)).toBe(cachedPdfPathFor(sha))
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('replaces an old readable name when exporting the same content again', async () => {
    const local = localPptxCacheDir()
    await mkdir(join(local, 'deck'))
    await rename(join(local, `${sha}.pdf`), join(local, 'deck', `${sha}.pdf`))
    await exportProjectCache(sha, source, projectDir)
    await mkdir(join(local, 'renamed'))
    await rename(join(local, 'deck', `${sha}.pdf`), join(local, 'renamed', `${sha}.pdf`))
    await exportProjectCache(sha, source, projectDir)
    expect(await readdir(join(projectDir, 'pptx-cache', 'renamed'))).toEqual([`${sha}.pdf`])
    expect(existsSync(join(projectDir, 'pptx-cache', 'deck', `${sha}.pdf`))).toBe(false)
  })

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

  it.each([
    null,
    { left: 0, top: 0, right: 0 },
    { left: '0', top: 0, right: 0, bottom: 0 },
    { left: 0.5, top: 0, right: 0.5, bottom: 0 },
    { left: 0, top: 0.6, right: 0, bottom: 0.5 },
  ])('rejects invalid imported source crop: %j', async (crop) => {
    await exportProjectCache(sha, source, projectDir)
    await writeFile(join(projectDir, 'pptx-cache', `${sha}.media.json`), JSON.stringify({
      ...manifest, slideMedia: [{ ...manifest.slideMedia[0], crop }],
    }))
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))).toBe(false)
  })

  it.each([{ autoPlay: 'true' }, { loop: 1 }, { autoPlay: null }])('rejects invalid playback metadata: %j', async (playback) => {
    await exportProjectCache(sha, source, projectDir)
    await writeFile(join(projectDir, 'pptx-cache', `${sha}.media.json`), JSON.stringify({
      ...manifest, slideMedia: [{ ...manifest.slideMedia[0], ...playback }],
    }))
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))).toBe(false)
  })

  it('adopts valid signed geometry and source crop', async () => {
    await exportProjectCache(sha, source, projectDir)
    await writeFile(join(projectDir, 'pptx-cache', `${sha}.media.json`), JSON.stringify({
      ...manifest, slideMedia: [{ ...manifest.slideMedia[0],
        rect: { x: -0.01, y: -0.02, w: 1.02, h: 1.04 },
        crop: { left: -0.01, top: 0, right: 0, bottom: 0.06476 },
      }],
    }))
    runtime.userData = join(dir, 'backup-user')
    expect(await useProjectCache(sha, source, join(projectDir, 'show.pdpres'))).toBe(true)
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
