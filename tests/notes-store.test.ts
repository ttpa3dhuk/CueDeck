import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadNotes, notesWriter, sha1FromBuffer, sidecarPathFor } from '../src/main/notes-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-notes-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sidecarPathFor', () => {
  it('кладёт <имя>.notes.json рядом с файлом', () => {
    expect(sidecarPathFor('/decks/show.pdf')).toBe('/decks/show.notes.json')
  })

  it('срезает только последнее расширение', () => {
    expect(sidecarPathFor('/decks/v2.final.pdf')).toBe('/decks/v2.final.notes.json')
  })
})

describe('sha1FromBuffer', () => {
  it('совпадает с node:crypto', () => {
    const buf = Buffer.from('hello')
    expect(sha1FromBuffer(buf)).toBe(createHash('sha1').update(buf).digest('hex'))
  })
})

describe('loadNotes', () => {
  it('нет sidecar-файла → пустые заметки без mismatch', async () => {
    const loaded = await loadNotes(join(dir, 'deck.pdf'), 'abc')
    expect(loaded).toEqual({ notes: {}, sha1Mismatch: false, storedSha1: null })
  })

  it('sha1 совпадает → заметки читаются, mismatch=false', async () => {
    const pdfPath = join(dir, 'deck.pdf')
    await writeFile(
      sidecarPathFor(pdfPath),
      JSON.stringify({ version: 1, pdfSha1: 'abc', notes: { 1: 'привет', 3: 'финал' } }),
    )
    const loaded = await loadNotes(pdfPath, 'abc')
    expect(loaded.sha1Mismatch).toBe(false)
    expect(loaded.storedSha1).toBe('abc')
    expect(loaded.notes).toEqual({ 1: 'привет', 3: 'финал' })
  })

  it('sha1 не совпадает (файл заменили) → mismatch=true, заметки всё равно доступны', async () => {
    const pdfPath = join(dir, 'deck.pdf')
    await writeFile(sidecarPathFor(pdfPath), JSON.stringify({ version: 1, pdfSha1: 'OLD', notes: { 1: 'x' } }))
    const loaded = await loadNotes(pdfPath, 'NEW')
    expect(loaded.sha1Mismatch).toBe(true)
    expect(loaded.storedSha1).toBe('OLD')
    expect(loaded.notes).toEqual({ 1: 'x' })
  })

  it('мусорные ключи/значения отфильтровываются', async () => {
    const pdfPath = join(dir, 'deck.pdf')
    await writeFile(
      sidecarPathFor(pdfPath),
      JSON.stringify({ version: 1, pdfSha1: 'abc', notes: { 1: 'ok', abc: 'не слайд', 2: 42 } }),
    )
    const loaded = await loadNotes(pdfPath, 'abc')
    expect(loaded.notes).toEqual({ 1: 'ok' })
  })

  it('битый JSON → ошибка пробрасывается (не тихий сброс заметок)', async () => {
    const pdfPath = join(dir, 'deck.pdf')
    await writeFile(sidecarPathFor(pdfPath), '{оборванный')
    await expect(loadNotes(pdfPath, 'abc')).rejects.toThrow()
  })
})

describe('notesWriter', () => {
  it('flush пишет sidecar атомарно, tmp-файлов не остаётся', async () => {
    const pdfPath = join(dir, 'deck.pdf')
    notesWriter.schedule(pdfPath, 'abc', { 1: 'заметка' })
    await notesWriter.flush()

    const files = await readdir(dir)
    expect(files).toEqual(['deck.notes.json'])
    const loaded = await loadNotes(pdfPath, 'abc')
    expect(loaded.notes).toEqual({ 1: 'заметка' })
    expect(loaded.sha1Mismatch).toBe(false)
  })

  it('flush без pending — no-op', async () => {
    await expect(notesWriter.flush()).resolves.toBeUndefined()
  })
})
