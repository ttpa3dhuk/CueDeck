import type { AppState, SlideBuildAnimation } from './types.js'
import { initialSlideVideo } from './slide-video.js'
import { FADE_MAX_MS } from './take-transition.js'

/** Zero preserves a cut; enabled presentation fades are 100–400 ms. */
export function sanitizeSlideFadeMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(100, Math.min(FADE_MAX_MS, Math.round(value))) : 0
}

export function validBuildAnimation(value: SlideBuildAnimation | undefined): value is SlideBuildAnimation {
  if (!value || !value.rect || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs > 10000) return false
  if (value.kind && !['fade', 'wipe-down', 'wipe-up', 'split-in-vertical', 'fly-bottom', 'appear', 'native-frames'].includes(value.kind)) return false
  if (value.delayMs !== undefined && (!Number.isFinite(value.delayMs) || value.delayMs < 0 || value.delayMs > 10000)) return false
  if(value.kind==='native-frames' && (typeof value.framesFile!=='string' || /[/\\\0]/.test(value.framesFile) || !value.framesFile.endsWith('.pdf') || !Number.isInteger(value.frameCount) || value.frameCount!<2 || value.frameCount!>31)) return false
  const { x, y, w, h } = value.rect
  return [x, y, w, h].every(Number.isFinite) && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1 && y + h <= 1
}

export function slideNavigationPatch(
  state: Pick<AppState, 'fileKind' | 'currentSlide' | 'totalSlides' | 'playlist' | 'currentPlaylistId' | 'slideMedia' | 'slideTransitions' | 'slideBuilds' | 'video'>,
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
  const candidate = state.fileKind === 'pptx' && mode === 'file' && sameSourceSlide && slide === state.currentSlide + 1 ? state.slideBuilds?.[slide] : undefined
  const buildAnimation = validBuildAnimation(candidate) ? candidate : undefined
  return {
    currentSlide: slide,
    takeTransition: { id, durationMs: buildAnimation?.durationMs ?? sanitizeSlideFadeMs(fade), scope: 'slide', ...(buildAnimation ? { buildAnimation } : {}) },
    ...(state.fileKind === 'pptx' ? initialSlideVideo(state.fileKind, state.slideMedia, slide, state.video.muted, now) : {}),
  }
}
