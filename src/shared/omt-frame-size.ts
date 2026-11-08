import type { OmtResolution } from './types.js'

/** Fit the captured frame inside the selected 16:9 output limit, without upscaling. */
export function omtFrameSize(width: number, height: number, resolution: OmtResolution): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const maxWidth = Math.round(resolution * 16 / 9)
  const scale = Math.min(1, maxWidth / width, resolution / height)
  return {
    width: Math.max(1, Math.min(maxWidth, Math.round(width * scale))),
    height: Math.max(1, Math.min(resolution, Math.round(height * scale))),
  }
}
