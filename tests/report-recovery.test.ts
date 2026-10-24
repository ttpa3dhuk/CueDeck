import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { initialState } from '../src/main/state'
import { buildRecoveryPackage, captureMarkerContext, readRecoveryProject, selectRecoveryMarker } from '../src/main/report-recovery'
import { loadProjectFile } from '../src/main/project'
import { ReportMaterialSelection } from '../src/main/report-materials'
import type { DiagMarker } from '../src/shared/types'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'cuedeck-recovery-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const original = join(root, 'original', 'Доклад.mp4')
  await mkdir(dirname(original))
  await writeFile(original, 'mock video')
  const state = initialState()
  state.pdfPath = original; state.fileKind = 'video'; state.currentSlide = 7
  state.video = { playing: true, anchorSec: 12, anchorAt: 10_000, durationSec: 120, muted: false }
  const marker: DiagMarker = { n: 3, at: '12:34:56', context: captureMarkerContext(state, 12_500) }
  const selection = new ReportMaterialSelection()
  const selected = await selection.select([original])
  const attachments = await selection.readWithSources(selected.token)
  const files = [...attachments, ...buildRecoveryPackage(marker, attachments)]
  const folder = join(root, 'распакованный отчёт')
  await mkdir(folder)
  for (const file of files) {
    const path = join(folder, file.name)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.data)
  }
  return { original, state, marker, folder, files, projectPath: join(folder, 'recovery.pdpres') }
}

it('captures the exact marker moment and a deep playback whitelist, not later state or private production settings', () => {
  const state = initialState()
  state.pdfPath = '/talk.pptx'; state.currentSlide = 5
  state.preview.path = '/next.mp4'; state.preview.currentSlide = 2
  state.video = { playing: true, anchorSec: 4, anchorAt: 1000, durationSec: 100, muted: false }
  state.timer = { durationMs: 60_000, elapsedMs: 500, startedAt: 1000, running: true, cycles: 1 }
  state.audienceTimer = { ...state.audienceTimer, elapsedMs: 10, startedAt: 2000, running: true, visible: true }
  state.notes = { 1: 'private speaker note' }
  state.stream.settings.destinations = [{ id: 'x', name: 'secret', url: 'rtmp://example.invalid', key: 'TOP-SECRET', enabled: true }]
  const context = captureMarkerContext(state, 3000)
  state.video.anchorSec = 90; state.currentSlide = 9; state.audienceTimer.position.x = 0
  expect(context.slide).toBe(5); expect(context.videoPositionSec).toBe(6)
  expect(context.video.anchorSec).toBe(4)
  expect(context.timer?.elapsedMs).toBe(2500)
  expect(context.audienceTimer?.elapsedMs).toBe(1010)
  expect(context.audienceTimer?.position.x).toBe(0.85)
  const json = JSON.stringify(context)
  expect(json).not.toContain('TOP-SECRET'); expect(json).not.toContain('private speaker note')
  expect(json).not.toContain('rtmp:'); expect(context.sourceSlide).toBeNull()
})

it('produces a portable normal project and restores marker position into an explicit paused preview plan', async () => {
  const f = await fixture()
  const projectText = await readFile(f.projectPath, 'utf8')
  const manifestText = await readFile(join(f.folder, 'recovery.json'), 'utf8')
  expect(projectText).not.toContain(f.original); expect(manifestText).not.toContain(f.original)
  const ordinary = await loadProjectFile(f.projectPath)
  expect(ordinary.playlist[0].filePath).toBe(join(f.folder, 'materials/1/Доклад.mp4'))
  expect(ordinary.playlist[0].loop).toBeUndefined() // false is not a persisted autoplay request
  expect(ordinary.keyVisualPath).toBeNull()
  const plan = await readRecoveryProject(f.projectPath)
  expect(plan.missing).toBe(0)
  expect(plan.preview).toEqual({ path: join(f.folder, 'materials/1/Доклад.mp4'), kind: 'video', slide: 7, positionSec: 14.5 })
  expect(plan.project.playlist[0].loop).toBe(false)
  expect(plan.project.keyVisualPath).toBeNull()
  expect(plan).not.toHaveProperty('stream')
})

it('lists unselected and missing materials instead of resolving them by basename or falling back to originals', async () => {
  const f = await fixture()
  f.marker.context!.previewPath = '/not-selected/Доклад.mp4'
  const rebuilt = buildRecoveryPackage(f.marker, [])
  const manifest = JSON.parse(rebuilt.find(f => f.name === 'recovery.json')!.data.toString())
  expect(manifest.complete).toBe(false)
  expect(manifest.materials.map((m: { status: string }) => m.status)).toEqual(['not-selected', 'not-selected'])
  expect(manifest.context.programPath).toBeNull()
  expect(JSON.stringify(manifest)).not.toContain('/not-selected/')
  await unlink(join(f.folder, 'materials/1/Доклад.mp4'))
  const plan = await readRecoveryProject(f.projectPath)
  expect(plan.missing).toBe(1); expect(plan.preview).toBeNull(); expect(plan.project.playlist).toEqual([])
  expect(await readFile(f.original, 'utf8')).toBe('mock video')
})

it('keeps duplicate Unicode filenames distinct through explicit selection, extraction and recovery', async () => {
  const f = await fixture()
  const next = join(root, 'other/Доклад.mp4')
  await mkdir(dirname(next)); await writeFile(next, 'next video')
  f.state.preview.path = next; f.state.preview.kind = 'video'; f.state.preview.currentSlide = 2
  const marker: DiagMarker = { n: 4, at: '12:35:00', context: captureMarkerContext(f.state, 15_000) }
  const selection = new ReportMaterialSelection()
  const selected = await selection.select([f.original, next])
  const attachments = await selection.readWithSources(selected.token)
  for (const file of [...attachments, ...buildRecoveryPackage(marker, attachments)]) {
    const path = join(f.folder, file.name)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.data)
  }
  const plan = await readRecoveryProject(f.projectPath)
  expect(plan.project.playlist.map(e => e.filePath)).toEqual([join(f.folder, 'materials/1/Доклад.mp4'), join(f.folder, 'materials/2/Доклад.mp4')])
  expect(await readFile(plan.project.playlist[1].filePath, 'utf8')).toBe('next video')
})

describe('untrusted extracted snapshots', () => {
  it.each(['../outside.mp4', '/etc/passwd.mp4', 'C:/secret.mp4', 'materials/../../secret.mp4', 'materials\\secret.mp4', 'live://camera', 'omt://source'])('rejects traversal, absolute and device path %s', async (path) => {
    const f = await fixture()
    const parsed = JSON.parse(await readFile(f.projectPath, 'utf8'))
    parsed.playlist[0].filePath = path
    await writeFile(f.projectPath, JSON.stringify(parsed))
    await expect(readRecoveryProject(f.projectPath)).rejects.toThrow()
  })
  it('rejects a symlink escape and metadata escape, while leaving the target untouched', async () => {
    const f = await fixture()
    const attached = join(f.folder, 'materials/1/Доклад.mp4')
    await unlink(attached); await symlink(f.original, attached)
    await expect(readRecoveryProject(f.projectPath)).rejects.toThrow('escapes')
    await unlink(attached); await writeFile(attached, 'inside')
    const metadata = join(f.folder, 'recovery.json')
    const outside = join(root, 'outside.json')
    await writeFile(outside, await readFile(metadata))
    await unlink(metadata); await symlink(outside, metadata)
    await expect(readRecoveryProject(f.projectPath)).rejects.toThrow('escapes')
    expect(await readFile(f.original, 'utf8')).toBe('mock video')
  })
  it('does not import arbitrary state, streaming credentials, device entries or project keys', async () => {
    const f = await fixture()
    const parsed = JSON.parse(await readFile(f.projectPath, 'utf8'))
    parsed.stream = { key: 'SECRET' }; parsed.audioOutputId = 'device'; parsed.keyVisualPath = '/private/image.png'
    parsed.playlist[0].stream = 'SECRET'; parsed.playlist[0].loop = true; parsed.playlist[0].speakerName = 'secret notes'
    await writeFile(f.projectPath, JSON.stringify(parsed))
    const plan = await readRecoveryProject(f.projectPath)
    expect(JSON.stringify(plan)).not.toContain('SECRET'); expect(JSON.stringify(plan)).not.toContain('/private/image.png')
    expect(plan.project.playlist[0].speakerName).toBe(''); expect(plan.project.playlist[0].loop).toBe(false)
    parsed.playlist[0].kind = 'live'
    await writeFile(f.projectPath, JSON.stringify(parsed))
    await expect(readRecoveryProject(f.projectPath)).rejects.toThrow()
  })
})

it('distinguishes explicit report-time state from the latest marker and rejects unknown marker IDs', () => {
  const state = initialState()
  state.currentSlide = 4
  const marker: DiagMarker = { n: 2, at: '12:34', context: captureMarkerContext(state, 1000) }
  state.currentSlide = 9
  expect(selectRecoveryMarker([marker], undefined, state, 2000).context?.slide).toBe(4)
  expect(selectRecoveryMarker([marker], 2, state, 2000)).toBe(marker)
  expect(selectRecoveryMarker([marker], 0, state, 2000).context?.slide).toBe(9)
  expect(selectRecoveryMarker([], undefined, state, 2000).n).toBe(0)
  for (const invalid of [-1, 1.5, NaN, 33]) expect(() => selectRecoveryMarker([marker], invalid, state, 2000)).toThrow()
})

it('bounds metadata and rejects arbitrary projects without a matching recovery manifest', async () => {
  const f = await fixture()
  await writeFile(join(f.folder, 'recovery.json'), ' '.repeat(2 * 1024 * 1024 + 1))
  await expect(readRecoveryProject(f.projectPath)).rejects.toThrow('too large')
  await expect(readRecoveryProject(join(f.folder, 'normal.pdpres'))).rejects.toThrow('Choose recovery.pdpres')
})

it('preserves the selected presentation fade but never accepts its out-of-range imported value', async () => {
  const f = await fixture()
  f.state.currentPlaylistId = 'active'
  f.state.playlist = [{ id: 'active', filePath: f.original, fileName: 'Доклад.mp4', kind: 'video', displayName: '', speakerName: '', durationMs: 0, slideFadeMs: 350 }]
  const marker: DiagMarker = { n: 5, at: '12:36', context: captureMarkerContext(f.state, 20_000) }
  const selection = new ReportMaterialSelection()
  const chosen = await selection.select([f.original])
  for (const file of buildRecoveryPackage(marker, await selection.readWithSources(chosen.token))) await writeFile(join(f.folder, file.name), file.data)
  expect((await readRecoveryProject(f.projectPath)).project.playlist[0].slideFadeMs).toBe(350)
  const parsed = JSON.parse(await readFile(f.projectPath, 'utf8')); parsed.playlist[0].slideFadeMs = 50_000
  await writeFile(f.projectPath, JSON.stringify(parsed))
  expect((await readRecoveryProject(f.projectPath)).project.playlist[0].slideFadeMs).toBe(500)
})

it('rejects an attached material with no path and duplicate program roles', async () => {
  const f = await fixture()
  const path = join(f.folder, 'recovery.json')
  const original = JSON.parse(await readFile(path, 'utf8'))
  const noPath = structuredClone(original); noPath.materials[0].path = null
  await writeFile(path, JSON.stringify(noPath))
  await expect(readRecoveryProject(f.projectPath)).rejects.toThrow('no path')
  const duplicate = structuredClone(original); duplicate.materials.push({ ...duplicate.materials[0] })
  await writeFile(path, JSON.stringify(duplicate))
  await expect(readRecoveryProject(f.projectPath)).rejects.toThrow('Duplicate')
})
