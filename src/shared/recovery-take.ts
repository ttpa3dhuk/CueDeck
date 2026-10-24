import type { DeckState, VideoState } from './types.js'

/** Explicit forensic TAKE preserves the staged frame, without autoplay. */
export function recoveryTakeFrame(preview: DeckState, positionSec: number): { slide: number; video: VideoState } | null {
  if (!preview.recoveryTake) return null
  const duration = Number.isFinite(preview.video.durationSec) ? Math.max(0, preview.video.durationSec) : 0
  const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0
  return {
    slide: Math.max(1, Math.min(preview.totalSlides || 1, preview.currentSlide)),
    video: { playing: false, anchorAt: null, muted: true, durationSec: duration, anchorSec: duration ? Math.min(position, duration) : position },
  }
}
