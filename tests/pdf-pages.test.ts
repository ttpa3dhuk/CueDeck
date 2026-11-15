import { describe, expect, it } from 'vitest'
import { countPdfPages } from '../src/main/pdf-pages'

function pdf(body: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF`, 'latin1')
}

describe('countPdfPages', () => {
  it('считает объекты /Type /Page', () => {
    const buf = pdf(
      '1 0 obj << /Type /Page /Parent 3 0 R >> endobj\n' +
        '2 0 obj << /Type /Page /Parent 3 0 R >> endobj',
    )
    expect(countPdfPages(buf)).toBe(2)
  })

  it('не считает узел дерева /Type /Pages', () => {
    const buf = pdf(
      '3 0 obj << /Type /Pages /Kids [1 0 R] /Count 1 >> endobj\n' +
        '1 0 obj << /Type /Page /Parent 3 0 R >> endobj',
    )
    expect(countPdfPages(buf)).toBe(1)
  })

  it('терпит отсутствие пробела: /Type/Page', () => {
    expect(countPdfPages(pdf('1 0 obj << /Type/Page >> endobj'))).toBe(1)
  })

  it('известное ограничение: object streams (PDF 1.5+) дают 0 — рендерер поправит через pdf:report-total', () => {
    // Страничные объекты сжаты внутри потока — литерального "/Type /Page" в файле нет.
    const buf = pdf('5 0 obj << /Type /ObjStm /N 3 /First 18 >> stream\n\nendstream endobj')
    expect(countPdfPages(buf)).toBe(0)
  })

  it('пустой буфер → 0', () => {
    expect(countPdfPages(Buffer.alloc(0))).toBe(0)
  })
})

import { PdfPageCounter, inspectPdfFile } from '../src/main/pdf-pages'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('does not turn the PDF buffer into a JavaScript string', () => {
  const bytes = pdf('/Type /Page /Type/Pages /Type\n/Page')
  bytes.toString = () => { throw new Error('whole-file string') }
  expect(countPdfPages(bytes)).toBe(2)
})

it('matches the former advisory pattern at every possible chunk boundary', () => {
  const bytes = Buffer.from('/Type/Pages /Type /Type\n/Page /Type\t\r\n\xa0/Page/Type/Page /Typ/Type /Page /Type /Pages /Type /Page', 'latin1')
  const expected = bytes.toString('latin1').match(/\/Type\s*\/Page(?!s)/g)!.length
  for (let split = 0; split <= bytes.length; ++split) {
    const counter = new PdfPageCounter()
    counter.add(bytes.subarray(0, split)); counter.add(bytes.subarray(split))
    expect(counter.total(), `split ${split}`).toBe(expected)
  }
  const counter = new PdfPageCounter()
  for (const byte of bytes) counter.add(Buffer.from([byte]))
  expect(counter.total()).toBe(expected)
})

it('retains only scanner state across arbitrarily long whitespace', () => {
  const counter = new PdfPageCounter()
  counter.add(Buffer.from('/Type'))
  for (let n = 0; n < 100; n++) counter.add(Buffer.alloc(8192, 32))
  counter.add(Buffer.from('/Page'))
  expect(counter.total()).toBe(1)
})

it('streams identity and page count from the same file contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuedeck-pdf-count-'))
  try {
    const bytes = pdf('/Type /Page /Type /Pages /Type/Page')
    const path = join(dir, 'source.pdf'); await writeFile(path, bytes)
    expect(await inspectPdfFile(path)).toEqual({ totalSlides: 2, sha1: createHash('sha1').update(bytes).digest('hex') })
    await expect(inspectPdfFile(join(dir, 'missing.pdf'))).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
