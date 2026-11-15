import { expect, it } from 'vitest'
import { fitPdfPage, masterPdfRaster, pdfRasterSize } from '../src/shared/pdf-frame-geometry'

it('shares one full-resolution key regardless of card/window size or DPR', () => {
  const output = masterPdfRaster([{ bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }])
  const page = { width: 1920, height: 1080 }
  const card = fitPdfPage(page, { width: 792, height: 628 })
  const resized = fitPdfPage(page, { width: 800, height: 628 })
  expect(card).toEqual({ width: 792, height: 445.5 })
  expect(resized).toEqual({ width: 800, height: 450 })
  expect(pdfRasterSize(page, output)).toEqual({ width: 1920, height: 1080 })
})

it('preserves portrait aspect and the 1080p cap even with Retina/4K displays', () => {
  expect(pdfRasterSize({ width: 720, height: 1080 }, { width: 1920, height: 1080 })).toEqual({ width: 720, height: 1080 })
  const output = masterPdfRaster([{ bounds: { width: 1920, height: 1080 }, scaleFactor: 2 }])
  expect(output).toEqual({ width: 1920, height: 1080 })
  expect(masterPdfRaster([{ bounds: { width: 8192, height: 8192 }, scaleFactor: 2 }])).toEqual(output)
  expect(pdfRasterSize({ width: 1920, height: 1080 }, output)).toEqual(output)
  const huge = pdfRasterSize({ width: 1000, height: 1000 }, { width: 8192, height: 8192 })
  expect(huge).toEqual({ width: 1080, height: 1080 })
  expect(() => pdfRasterSize({ width: 0, height: 1 }, output)).toThrow('geometry')
})
