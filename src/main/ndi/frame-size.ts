import type { NdiResolution } from '../../shared/types.js'

/** Fit either orientation within the selected output bounds without upscaling. */
export function ndiFrameSize(width: number, height: number, resolution: NdiResolution): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) return null
  const maxWidth = Math.round(resolution * 16 / 9)
  const scale = Math.min(1, maxWidth / width, resolution / height)
  return {
    width: Math.max(2, Math.floor(width * scale / 2) * 2),
    height: Math.max(2, Math.floor(height * scale / 2) * 2),
  }
}
