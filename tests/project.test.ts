import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_SCHEMA_VERSION, loadProjectFile, saveProjectFile } from '../src/main/project'
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
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
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

describe('относительные пути (schema v2)', () => {
  it('материал рядом с проектом сохраняется относительным и разворачивается обратно', async () => {
    const projectPath = join(dir, 'шоу.pdpres')
    const deckPath = join(dir, 'материалы', 'доклад.pdf')
    await saveProjectFile(projectPath, {
      playlist: [entry({ filePath: deckPath, fileName: 'доклад.pdf' })],
      keyVisualPath: join(dir, 'kv.png'),
    })

    const raw = JSON.parse(await readFile(projectPath, 'utf-8'))
    expect(raw.playlist[0].filePath).toBe('материалы/доклад.pdf')
    expect(raw.keyVisualPath).toBe('kv.png')

    const loaded = await loadProjectFile(projectPath)
    expect(loaded.playlist[0].filePath).toBe(deckPath)
    expect(loaded.keyVisualPath).toBe(join(dir, 'kv.png'))
  })

  it('проект, переехавший в другую папку, всё ещё находит свои материалы', async () => {
    const projectPath = join(dir, 'шоу.pdpres')
    await saveProjectFile(projectPath, {
      playlist: [entry({ filePath: join(dir, 'доклад.pdf') })],
      keyVisualPath: null,
    })

    // Эмуляция флешки: та же папка целиком уехала на другую машину.
    const moved = await mkdtemp(join(tmpdir(), 'cuedeck-moved-'))
    const movedProject = join(moved, 'шоу.pdpres')
    await writeFile(movedProject, await readFile(projectPath, 'utf-8'), 'utf-8')

    const loaded = await loadProjectFile(movedProject)
    expect(loaded.playlist[0].filePath).toBe(join(moved, 'доклад.pdf'))
    await rm(moved, { recursive: true, force: true })
  })

  it('материал вне папки проекта остаётся абсолютным', async () => {
    const projectPath = join(dir, 'шоу.pdpres')
    const outside = join(tmpdir(), 'cuedeck-outside', 'чужой.pdf')
    await saveProjectFile(projectPath, {
      playlist: [entry({ filePath: outside })],
      keyVisualPath: null,
    })
    const raw = JSON.parse(await readFile(projectPath, 'utf-8'))
    expect(raw.playlist[0].filePath).toBe(outside)
    expect((await loadProjectFile(projectPath)).playlist[0].filePath).toBe(outside)
  })

  it('живой вход не трогаем — это не файл', async () => {
    const projectPath = join(dir, 'шоу.pdpres')
    const live = 'live://device?v=USB%20Capture'
    await saveProjectFile(projectPath, {
      playlist: [entry({ kind: 'live', filePath: live, fileName: 'Ноут ведущего' })],
      keyVisualPath: null,
    })
    const raw = JSON.parse(await readFile(projectPath, 'utf-8'))
    expect(raw.playlist[0].filePath).toBe(live)
    expect((await loadProjectFile(projectPath)).playlist[0].filePath).toBe(live)
  })

  it('старый проект с абсолютными путями (v1) читается как раньше', async () => {
    const projectPath = join(dir, 'старый.pdpres')
    await writeFile(
      projectPath,
      JSON.stringify({
        schemaVersion: 1,
        playlist: [{ id: 'x', kind: 'pdf', filePath: '/decks/a.pdf', fileName: 'a.pdf' }],
        keyVisualPath: '/decks/kv.png',
      }),
      'utf-8',
    )
    const loaded = await loadProjectFile(projectPath)
    expect(loaded.playlist[0].filePath).toBe('/decks/a.pdf')
    expect(loaded.keyVisualPath).toBe('/decks/kv.png')
  })
})

describe('необязательные поля записи', () => {
  it('loop и liveFit переживают сохранение и загрузку проекта', async () => {
    const path = join(dir, 'flags.pdpres')
    await saveProjectFile(path, {
      playlist: [
        entry({ id: 'v1', kind: 'video', filePath: '/kv.mp4', fileName: 'kv.mp4', loop: true }),
        entry({ id: 'l1', kind: 'live', filePath: 'live://device?v=Cam', fileName: 'Вход', liveFit: 'cover' }),
        entry({ id: 'p1' }),
      ],
      keyVisualPath: null,
    })
    const loaded = await loadProjectFile(path)
    expect(loaded.playlist[0].loop).toBe(true)
    expect(loaded.playlist[1].liveFit).toBe('cover')
    // Обычная запись флагов не получает — в файле не должно быть мусора.
    expect(loaded.playlist[2].loop).toBeUndefined()
    expect(loaded.playlist[2].liveFit).toBeUndefined()
  })
})

describe('список (пачка фото и роликов)', () => {
  it('материалы списка тоже становятся относительными и разворачиваются обратно', async () => {
    const projectPath = join(dir, 'show.pdpres')
    const photo = join(dir, 'фото', 'gala-01.jpg')
    const clip = join(dir, 'фото', 'promo.mp4')
    await saveProjectFile(projectPath, {
      playlist: [
        entry({
          id: 'list-1',
          kind: 'list',
          filePath: '',
          fileName: 'Список — 1 фото, 1 видео',
          photoSec: 12,
          loop: true,
          items: [
            { path: photo, fileName: 'gala-01.jpg', kind: 'image' },
            { path: clip, fileName: 'promo.mp4', kind: 'video' },
          ],
        }),
      ],
      keyVisualPath: null,
    })

    const raw = JSON.parse(await readFile(projectPath, 'utf-8'))
    expect(raw.playlist[0].items.map((i: { path: string }) => i.path)).toEqual([
      'фото/gala-01.jpg',
      'фото/promo.mp4',
    ])

    const loaded = await loadProjectFile(projectPath)
    expect(loaded.playlist[0].items?.[0].path).toBe(photo)
    expect(loaded.playlist[0].items?.[1].path).toBe(clip)
    expect(loaded.playlist[0].photoSec).toBe(12)
    expect(loaded.playlist[0].loop).toBe(true)
  })
})
