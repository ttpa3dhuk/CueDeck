import { expect, it } from 'vitest'
import { pdfImageDecoderOption } from '../src/renderer/shared/pdf-image-decoder'

it('uses native PDF image decoding in the tested Chromium runtime and newer', () => {
  expect(pdfImageDecoderOption('Mozilla/5.0 Chrome/152.0.7977.149 Electron/44.7.2', true)).toBe(true)
  expect(pdfImageDecoderOption('Chromium/153.0.0.0', true)).toBe(true)
})

it('retains the PDF.js JS fallback on old Chromium and without ImageDecoder', () => {
  expect(pdfImageDecoderOption('Chrome/130.0.0.0 Electron/33.4.11', true)).toBe(false)
  expect(pdfImageDecoderOption('Chrome/152.0.7977.149', false)).toBe(false)
  expect(pdfImageDecoderOption('Chrome/151.0.0.0', true)).toBe(false)
})

it('leaves PDF.js defaults in place outside Chromium', () => {
  for (const userAgent of ['', 'Node.js/22', 'Firefox/140.0', 'Version/18.0 Safari/605.1.15']) {
    expect(pdfImageDecoderOption(userAgent, true)).toBeUndefined()
  }
})
