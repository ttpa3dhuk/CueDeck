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
