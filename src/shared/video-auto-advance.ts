import type { AppState } from './types.js'
import { slideNavigationPatch } from './slide-transition.js'
import { sanitizeTakeFadeMs } from './take-transition.js'

export type AutoVideoTarget = { slide: number; fadeMs: number } | { entryId: string; fadeMs: number }

/** The existing Auto advance switch opts in; loops and lists retain their owners. */
export function autoVideoTarget(s: AppState): AutoVideoTarget | null {
  if (!s.autoAdvance || s.videoLoop || s.listIndex >= 0 || !s.video.playing ||
      !['video', 'pptx'].includes(s.fileKind ?? '')) return null
  if (s.fileKind === 'pptx') {
    if (!s.slideMedia.some(m => m.slide === s.currentSlide && m.kind !== 'gif')) return null
    if (s.currentSlide < s.totalSlides) {
      const slide = s.currentSlide + 1
      return { slide, fadeMs: slideNavigationPatch(s, slide, 'auto')?.takeTransition?.durationMs ?? 0 }
    }
  }
  const index = s.playlist.findIndex(e => e.id === s.currentPlaylistId)
  const next = index >= 0 ? s.playlist[index + 1] : undefined
  // A list owns a separate asynchronous lifecycle; do not open its pseudo-path.
  return next && next.kind !== 'list' ? { entryId: next.id, fadeMs: sanitizeTakeFadeMs(s.takeFadeMs) } : null
}

export function autoVideoIdentity(s: AppState): string {
  return JSON.stringify([s.pdfPath, s.pdfSha1, s.currentPlaylistId, s.currentSlide,
    s.video.anchorSec, s.video.anchorAt, s.video.range, s.video.playing, s.autoAdvance, s.videoLoop])
}

export function autoVideoStillTargets(s: AppState, entryId: string | null | undefined, path: string): boolean {
  const target = autoVideoTarget(s)
  return Boolean(target && 'entryId' in target && target.entryId === entryId &&
    s.playlist.some(entry => entry.id === entryId && entry.filePath === path))
}
