import type { AppState } from './types.js'
import { initialSlideVideo } from './slide-video.js'
import { FADE_MAX_MS } from './take-transition.js'

/** Zero preserves a cut; enabled presentation fades are 100–400 ms. */
export function sanitizeSlideFadeMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(100, Math.min(FADE_MAX_MS, Math.round(value))) : 0
}

export function slideNavigationPatch(
  state: Pick<AppState, 'fileKind' | 'currentSlide' | 'totalSlides' | 'playlist' | 'currentPlaylistId' | 'slideMedia' | 'slideTransitions' | 'video'>,
  slide: number, id: string, now = Date.now(),
): Partial<AppState> | null {
  if ((state.fileKind !== 'pdf' && state.fileKind !== 'pptx') ||
    !Number.isInteger(slide) || slide < 1 || slide > state.totalSlides || slide === state.currentSlide) return null
  const entry = state.playlist.find(item => item.id === state.currentPlaylistId)
  const mode = entry?.slideFadeMode ?? (entry?.slideFadeMs !== undefined ? (entry.slideFadeMs > 0 ? 'custom' : 'cut') : 'file')
  const sourcePage = (page: number): number | undefined => Object.keys(state.slideTransitions ?? {}).map(Number)
    .filter(start => start > 0 && start <= page).sort((a, b) => b - a)[0]
  const sameSourceSlide = sourcePage(state.currentSlide) !== undefined && sourcePage(state.currentSlide) === sourcePage(slide)
  const fade = mode === 'cut' ? 0 : mode === 'custom' ? entry?.slideFadeMs
    : state.fileKind === 'pptx' && !sameSourceSlide ? state.slideTransitions?.[slide] : 0
  return {
    currentSlide: slide,
    takeTransition: { id, durationMs: sanitizeSlideFadeMs(fade), scope: 'slide' },
    ...(state.fileKind === 'pptx' ? initialSlideVideo(state.fileKind, state.slideMedia, slide, state.video.muted, now) : {}),
  }
}
