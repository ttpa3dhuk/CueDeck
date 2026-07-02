import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProjectFile, saveProjectFile } from '../src/main/project'
import type { PlaylistEntry } from '../src/shared/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-project-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function entry(partial: Partial<PlaylistEntry> = {}): PlaylistEntry {
  return {
    id: 'id-1',
    kind: 'pdf',
    filePath: '/decks/a.pdf',
    fileName: 'a.pdf',
    displayName: '',
    speakerName: 'Спикер',
    durationMs: 15 * 60_000,
    ...partial,
  }
}

describe('saveProjectFile + loadProjectFile', () => {
  it('roundtrip: что сохранили, то и загрузили', async () => {
    const path = join(dir, 'show.pdpres')
    const playlist = [entry(), entry({ id: 'id-2', kind: 'video', filePath: '/v.mp4', fileName: 'v.mp4', displayName: 'Ролик' })]
    await saveProjectFile(path, { playlist, keyVisualPath: '/kv.png' })

    const loaded = await loadProjectFile(path)
    expect(loaded.playlist).toEqual(playlist)
    expect(loaded.keyVisualPath).toBe('/kv.png')
  })

  it('атомарная запись: tmp-файлов после сохранения не остаётся', async () => {
    const path = join(dir, 'show.pdpres')
    await saveProjectFile(path, { playlist: [entry()], keyVisualPath: null })
    const files = await readdir(dir)
    expect(files).toEqual(['show.pdpres'])
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    expect(parsed.schemaVersion).toBe(1)
  })
})

describe('миграция legacy-полей .pdpres', () => {
  it('pdfPath/pdfName → filePath/fileName, kind по умолчанию pdf', async () => {
    const path = join(dir, 'legacy.pdpres')
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        playlist: [{ id: 'x', pdfPath: '/old/deck.pdf', pdfName: 'deck.pdf', speakerName: 'Иван', durationMs: 60000 }],
        keyVisualPath: null,
      }),
    )
    const loaded = await loadProjectFile(path)
    expect(loaded.playlist).toEqual([
      {
        id: 'x',
        kind: 'pdf',
        filePath: '/old/deck.pdf',
        fileName: 'deck.pdf',
        displayName: '',
        speakerName: 'Иван',
        durationMs: 60000,
      },
    ])
  })

  it('запись без id получает сгенерированный, fileName выводится из пути', async () => {
    const path = join(dir, 'noid.pdpres')
    await writeFile(path, JSON.stringify({ playlist: [{ filePath: '/d/slides.pdf' }] }))
    const loaded = await loadProjectFile(path)
    expect(loaded.playlist).toHaveLength(1)
    expect(loaded.playlist[0].id).toBeTruthy()
    expect(loaded.playlist[0].fileName).toBe('slides.pdf')
    expect(loaded.playlist[0].durationMs).toBe(30 * 60_000)
  })

  it('битые записи (без пути / не объекты) отбрасываются', async () => {
    const path = join(dir, 'broken.pdpres')
    await writeFile(
      path,
      JSON.stringify({ playlist: [null, 42, { speakerName: 'без пути' }, { filePath: '/ok.pdf' }] }),
    )
    const loaded = await loadProjectFile(path)
    expect(loaded.playlist).toHaveLength(1)
    expect(loaded.playlist[0].filePath).toBe('/ok.pdf')
  })

  it('отсутствие playlist / не-строковый keyVisualPath → пустой список и null', async () => {
    const path = join(dir, 'empty.pdpres')
    await writeFile(path, JSON.stringify({ keyVisualPath: 123 }))
    const loaded = await loadProjectFile(path)
    expect(loaded.playlist).toEqual([])
    expect(loaded.keyVisualPath).toBeNull()
  })
})
