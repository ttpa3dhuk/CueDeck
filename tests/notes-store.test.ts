import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadNotes, NotesWriter, notesWriter, sha1FromBuffer, sidecarPathFor } from '../src/main/notes-store'
import { presentationNotesPath } from '../src/main/presentation-notes-path'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-notes-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sidecarPathFor', () => {
  it('isolates notes edited on PowerPoint static pages from LibreOffice animation pages', async () => {
    const source = join(dir, 'deck.pptx')
    const lo = presentationNotesPath(source, 'source-sha')
    const pp = presentationNotesPath(source, 'powerpoint-cache-sha', 'source-sha')
    expect(sidecarPathFor(pp)).not.toBe(sidecarPathFor(lo))
    const writer = new NotesWriter()
    writer.schedule(lo, 'source-sha', { 2: 'LibreOffice step 1' })
    writer.schedule(pp, 'powerpoint-cache-sha', { 2: 'PowerPoint slide 2' })
    await writer.flush()
    expect((await loadNotes(lo, 'source-sha')).notes).toEqual({ 2: 'LibreOffice step 1' })
    expect((await loadNotes(pp, 'powerpoint-cache-sha')).notes).toEqual({ 2: 'PowerPoint slide 2' })
  })
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
  it('keeps changes to multiple documents and snapshots the supplied notes', async () => {
    const writer = new NotesWriter(), a = join(dir, 'a.pdf'), b = join(dir, 'b.pdf')
    const notes = { 1: 'A' }
    writer.schedule(a, 'a', notes); writer.schedule(b, 'b', { 1: 'B' }); notes[1] = 'unsubmitted'
    await writer.flush()
    expect((await loadNotes(a, 'a')).notes).toEqual({ 1: 'A' })
    expect((await loadNotes(b, 'b')).notes).toEqual({ 1: 'B' })
  })
  it('waits for in-flight writes and drains edits that arrive during the write', async () => {
    const writer = new NotesWriter(), a = join(dir, 'a.pdf'), b = join(dir, 'b.pdf')
    writer.schedule(a, 'a', { 1: 'old' })
    let finished = false
    const first = writer.flush().then(() => { finished = true })
    writer.schedule(a, 'a', { 1: 'new' }); writer.schedule(b, 'b', { 1: 'B' })
    await writer.flush()
    expect(finished).toBe(true)
    expect(JSON.parse(await readFile(sidecarPathFor(a), 'utf8')).notes).toEqual({ 1: 'new' })
    expect(JSON.parse(await readFile(sidecarPathFor(b), 'utf8')).notes).toEqual({ 1: 'B' })
    await first
  })
  it('waits for an in-flight write even when no new edit is queued', async () => {
    const writer = new NotesWriter(), a = join(dir, 'a.pdf')
    writer.schedule(a, 'a', { 1: 'A' })
    let finished = false
    const first = writer.flush().then(() => { finished = true })
    await writer.flush(); expect(finished).toBe(true); await first
  })
  it('retains failed data for retry and removes its temporary file', async () => {
    const writer = new NotesWriter(), folder = join(dir, 'later'), a = join(folder, 'a.pdf')
    writer.schedule(a, 'a', { 1: 'keep' })
    await expect(writer.flush()).rejects.toThrow()
    expect(writer.pendingNotes(a, 'a')?.notes).toEqual({ 1: 'keep' })
    await mkdir(folder); await writer.flush()
    expect(await readdir(folder)).toEqual(['a.notes.json'])
    expect((await loadNotes(a, 'a')).notes).toEqual({ 1: 'keep' })
  })
  it('still saves other documents if one sidecar cannot be written', async () => {
    const writer = new NotesWriter(), folder = join(dir, 'later'), a = join(folder, 'a.pdf'), b = join(dir, 'b.pdf')
    writer.schedule(a, 'a', { 1: 'A' }); writer.schedule(b, 'b', { 1: 'B' })
    await expect(writer.flush()).rejects.toThrow()
    expect((await loadNotes(b, 'b')).notes).toEqual({ 1: 'B' })
    await mkdir(folder); await writer.flush()
    expect((await loadNotes(a, 'a')).notes).toEqual({ 1: 'A' })
  })
  it('reloads a material from pending notes before the debounce expires', async () => {
    const a = join(dir, 'a.pdf')
    notesWriter.schedule(a, 'new', { 1: 'latest' })
    try {
      const loaded = await loadNotes(a, 'old')
      expect(loaded).toEqual({ notes: { 1: 'latest' }, sha1Mismatch: true, storedSha1: 'new' })
      loaded.notes[1] = 'not scheduled'
    } finally { await notesWriter.flush() }
    expect((await loadNotes(a, 'new')).notes).toEqual({ 1: 'latest' })
  })
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
