import { it, expect } from 'vitest'
import { mkdtemp, writeFile, truncate, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readDeckFile, PDF_RANGE_THRESHOLD, resolvePdfDocument } from '../src/main/pdf-source'

it('returns bounded range descriptors for large PDFs and bytes for small files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuedeck-pdf-source-'))
  try {
    const path = join(root, 'deck.pdf'); await writeFile(path, '%PDF-1.4')
    const url = 'cuedeck-media://document/program?v=abc'
    expect((await readDeckFile(path, 'application/pdf', url)).bytes.byteLength).toBe(8)
    await truncate(path, PDF_RANGE_THRESHOLD)
    const data = await readDeckFile(path, 'application/pdf', url)
    expect(data.bytes.byteLength).toBe(0)
    expect(data.pdf).toEqual({ url, size: PDF_RANGE_THRESHOLD })
    await writeFile(path, 'image')
    expect((await readDeckFile(path, 'image/png', url)).pdf).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('serves only current PDF decks with the correct content identity', () => {
  const program = { path: '/show.pdf', kind: 'pdf', sha1: 'abc' }
  const preview = { path: '/next.pptx', kind: 'pptx', sha1: 'def' }
  const resolve = (url: string) => resolvePdfDocument(new URL(url), program, preview, h => '/cache/' + h + '.pdf')
  expect(resolve('cuedeck-media://document/program?v=abc')).toBe('/show.pdf')
  expect(resolve('cuedeck-media://document/preview?v=def')).toBe('/cache/def.pdf')
  for (const url of ['cuedeck-media://document/program?v=stale', 'cuedeck-media://document/program',
    'cuedeck-media://document/etc/passwd?v=abc', 'cuedeck-media://stream/program?v=abc']) expect(resolve(url)).toBeNull()
  expect(resolvePdfDocument(new URL('cuedeck-media://document/program?v=abc'), { ...program, kind: 'video' }, preview, h => h)).toBeNull()
})
