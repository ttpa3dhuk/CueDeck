import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beginProjectTransfer, endProjectTransfer, isProjectTransferRunning, transferProject } from '../src/main/project-transfer'
import { loadProjectFile } from '../src/main/project'
import { sidecarPathFor } from '../src/main/notes-store'
import type { PlaylistEntry, ProjectTransferStatus } from '../src/shared/types'

let dir: string, source: string, parent: string
const entry = (path: string, id = 'one'): PlaylistEntry => ({
  id, kind: 'pdf', filePath: path, fileName: 'deck.pdf', displayName: '', speakerName: '', durationMs: 0,
})
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-transfer-'))
  source = join(dir, 'deck.pdf')
  parent = join(dir, 'usb')
  await mkdir(parent)
  await writeFile(source, 'original bytes')
})
afterEach(async () => { endProjectTransfer(); await rm(dir, { recursive: true, force: true }) })

function options() {
  return { parent, name: 'show', playlist: [entry(source)], keyVisualPath: null,
    prepare: async () => [], progress: (_status: ProjectTransferStatus) => {},
  }
}

describe('project transfer', () => {
  it('publishes a readable project with relative paths, notes and verified material', async () => {
    await writeFile(sidecarPathFor(source), '{"notes":{"1":"operator"}}')
    const statuses: ProjectTransferStatus[] = []
    const result = await transferProject({ ...options(), progress: (status) => statuses.push(status) })
    expect(result.copied).toBe(1)
    const loaded = await loadProjectFile(result.path)
    expect(await readFile(loaded.playlist[0].filePath, 'utf8')).toBe('original bytes')
    expect(await readFile(sidecarPathFor(loaded.playlist[0].filePath), 'utf8')).toContain('operator')
    expect((await readFile(result.path, 'utf8'))).not.toContain(dir)
    expect(statuses.map((s) => s.phase)).toContain('checking')
    expect(statuses.at(-1)?.phase).toBe('done')
    expect(await readdir(parent)).toEqual(['show'])
  })

  it('uses the initial playlist despite operator edits and does not modify the live playlist', async () => {
    const playlist = [entry(source)]
    const result = await transferProject({ ...options(), playlist, prepare: async () => {
      playlist[0].speakerName = 'edited live'
      playlist.push(entry(join(dir, 'not-present.pdf'), 'new'))
      return []
    } })
    const loaded = await loadProjectFile(result.path)
    expect(loaded.playlist).toHaveLength(1)
    expect(loaded.playlist[0].speakerName).toBe('')
    expect(playlist).toHaveLength(2)
    expect(playlist[0].filePath).toBe(source)
  })

  it('does not expose a ready project while preparation is in progress', async () => {
    await transferProject({ ...options(), prepare: async (_source, _target, stage) => {
      expect(existsSync(join(parent, 'show'))).toBe(false)
      expect(existsSync(join(stage, 'show.pdpres'))).toBe(false)
      return []
    } })
    expect(existsSync(join(parent, 'show', 'show.pdpres'))).toBe(true)
  })

  it('keeps the initial operator notes when they are edited during a slow copy', async () => {
    const sidecar = sidecarPathFor(source)
    await writeFile(sidecar, 'initial notes')
    const result = await transferProject({ ...options(), prepare: async () => {
      await writeFile(sidecar, 'edited during transfer')
      return []
    } })
    const loaded = await loadProjectFile(result.path)
    expect(await readFile(sidecarPathFor(loaded.playlist[0].filePath), 'utf8')).toBe('initial notes')
    expect(await readFile(sidecar, 'utf8')).toBe('edited during transfer')
  })

  it('detects a damaged material copy and removes its unfinished staging folder', async () => {
    await expect(transferProject({ ...options(), prepare: async (_source, target) => {
      await writeFile(target, 'corrupted')
      return []
    } })).rejects.toThrow()
    expect(await readdir(parent)).toEqual([])
  })

  it('verifies cache videos too, so an incomplete copy is never marked ready', async () => {
    const video = join(dir, 'video.mp4')
    await writeFile(video, 'video bytes')
    await expect(transferProject({ ...options(), prepare: async (_source, _target, stage) => {
      const target = join(stage, 'cache.mp4')
      await writeFile(target, 'wrong bytes')
      return [{ source: video, target }]
    } })).rejects.toThrow()
    expect(await readdir(parent)).toEqual([])
  })

  it('fails for a missing original instead of publishing a partially ready project', async () => {
    await rm(source)
    await expect(transferProject(options())).rejects.toThrow()
    expect(await readdir(parent)).toEqual([])
  })

  it('keeps previous backups intact and chooses a new folder', async () => {
    await mkdir(join(parent, 'show'))
    await writeFile(join(parent, 'show', 'old.pdpres'), 'old backup')
    const result = await transferProject(options())
    expect(result.path).toBe(join(parent, 'show (2)', 'show.pdpres'))
    expect(await readFile(join(parent, 'show', 'old.pdpres'), 'utf8')).toBe('old backup')
  })

  it('copies shared list materials and a key visual once, keeping live inputs', async () => {
    const list = { ...entry('', 'list'), kind: 'list' as const, items: [{ path: source, fileName: 'deck.pdf', kind: 'image' as const }] }
    const live = { ...entry('live://device?v=Camera', 'live'), kind: 'live' as const }
    const result = await transferProject({ ...options(), playlist: [entry(source), list, live], keyVisualPath: source })
    expect(result.copied).toBe(1)
    const loaded = await loadProjectFile(result.path)
    expect(loaded.playlist[1].items?.[0].path).toBe(loaded.playlist[0].filePath)
    expect(loaded.playlist[2].filePath).toBe(live.filePath)
    expect(loaded.keyVisualPath).toBe(loaded.playlist[0].filePath)
  })

  it('allows only one transfer at a time and releases the guard afterwards', () => {
    expect(beginProjectTransfer()).toBe(true)
    expect(isProjectTransferRunning()).toBe(true)
    expect(beginProjectTransfer()).toBe(false)
    endProjectTransfer()
    expect(isProjectTransferRunning()).toBe(false)
    expect(beginProjectTransfer()).toBe(true)
  })
})
