import type { OmtResolution } from './types.js'

/** Fit the captured frame inside the selected 16:9 output limit, without upscaling. */
export function omtFrameSize(width: number, height: number, resolution: OmtResolution): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height <= 0) return null
  const maxWidth = Math.round(resolution * 16 / 9)
  const scale = Math.min(1, maxWidth / width, resolution / height)
  return {
    // VMX rejects odd widths, including the 405px result of portrait 720p.
    // Round to an even pixel count, still bounded by the source and output.
    width: Math.min(Math.floor(Math.min(width, maxWidth) / 2) * 2, Math.max(2, Math.round(width * scale / 2) * 2)),
    height: Math.max(1, Math.min(resolution, Math.round(height * scale))),
  }
}
