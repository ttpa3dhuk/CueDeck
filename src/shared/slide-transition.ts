import type { AppState } from './types.js'
import { initialSlideVideo } from './slide-video.js'

/** Zero preserves a cut; enabled presentation fades are 100–500 ms. */
export function sanitizeSlideFadeMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(100, Math.min(500, Math.round(value))) : 0
}

export function slideNavigationPatch(
  state: Pick<AppState, 'fileKind' | 'currentSlide' | 'totalSlides' | 'playlist' | 'currentPlaylistId' | 'slideMedia' | 'video'>,
  slide: number, id: string, now = Date.now(),
): Partial<AppState> | null {
  if ((state.fileKind !== 'pdf' && state.fileKind !== 'pptx') ||
    !Number.isInteger(slide) || slide < 1 || slide > state.totalSlides || slide === state.currentSlide) return null
  const entry = state.playlist.find(item => item.id === state.currentPlaylistId)
  return {
    currentSlide: slide,
    takeTransition: { id, durationMs: sanitizeSlideFadeMs(entry?.slideFadeMs), scope: 'slide' },
    ...(state.fileKind === 'pptx' ? initialSlideVideo(state.fileKind, state.slideMedia, slide, state.video.muted, now) : {}),
  }
}
