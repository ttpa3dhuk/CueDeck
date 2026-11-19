import type { PdfLoader } from './animation-frame-loader'
import type { SlideMediaRect } from '../../shared/types'
const fullSlide = { x: 0, y: 0, w: 1, h: 1 }
/** Recover the foreground from two PowerPoint renders with known backgrounds. */
export function recoverForeground(black: Uint8ClampedArray, white: Uint8ClampedArray): void {
  for (let i = 0; i < black.length; i += 4) {
    const alpha =
      255 - Math.round((white[i] - black[i] + white[i + 1] - black[i + 1] + white[i + 2] - black[i + 2]) / 3)
    black[i + 3] = alpha
    if (alpha > 0 && alpha < 255) {
      for (let channel = 0; channel < 3; channel++) black[i + channel] *= 255 / alpha
    }
  }
}

export async function renderForegroundPair(
  loader: PdfLoader,
  page: number,
  width: number,
  signal: AbortSignal,
  region: SlideMediaRect = fullSlide,
): Promise<HTMLCanvasElement | undefined> {
  const black = await loader.renderRegion(page, region, width, signal)
  if (!black) return undefined
  let white: HTMLCanvasElement | null = null
  let retained = false
  try {
    white = await loader.renderRegion(page + 1, region, width, signal)
    if (!white || signal.aborted) return undefined
    const ctx = black.getContext('2d')!
    const dark = ctx.getImageData(0, 0, black.width, black.height)
    const light = white.getContext('2d')!.getImageData(0, 0, white.width, white.height)
    recoverForeground(dark.data, light.data)
    ctx.putImageData(dark, 0, 0)
    retained = true
    return black
  } finally {
    if (white) white.width = white.height = 0
    if (!retained) black.width = black.height = 0
  }
}
