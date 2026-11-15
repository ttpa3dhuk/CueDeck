export interface RasterSize { width: number; height: number }
const MASTER = { width: 1920, height: 1080 }

/** One 1080p raster shared by every output and Next. Retina/DPI and a 4K
 * display scale presentation only; they must not raise the render budget. */
export function masterPdfRaster(_displays: { bounds: RasterSize; scaleFactor: number }[] = []): RasterSize {
  return { ...MASTER }
}

export function pdfRasterSize(page: RasterSize, output: RasterSize): RasterSize {
  if (![page.width, page.height, output.width, output.height].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error('Invalid PDF page geometry')
  }
  const scale = Math.min(Math.min(output.width, MASTER.width) / page.width,
    Math.min(output.height, MASTER.height) / page.height)
  return { width: Math.max(1, Math.floor(page.width * scale)), height: Math.max(1, Math.floor(page.height * scale)) }
}

/** Fit the intrinsic page, rather than its integer-rounded canvas, so small
 * raster roundoff never moves the picture when the card is resized. */
export function fitPdfPage(page: RasterSize, target: RasterSize): RasterSize {
  const scale = Math.min(target.width / page.width, target.height / page.height)
  return { width: page.width * scale, height: page.height * scale }
}
