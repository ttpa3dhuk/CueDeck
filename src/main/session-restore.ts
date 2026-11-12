import { createAudienceTimer } from '../shared/audience-timer.js'
import type { SessionCheckpoint } from '../shared/startup-settings.js'
import type { OpenPdfResult } from '../shared/types.js'
import { initialDeckState, initialVideoState, store } from './state.js'

/** Clear the previous show even when a recovered deck is empty or unavailable. */
export function clearSessionDecks(): void {
  store.patch({ pdfPath: null, pdfSha1: null, fileKind: null, totalSlides: 0,
    sourceMuted: false,
    currentSlide: 1, currentPlaylistId: null, notes: {}, slideMedia: [],
    video: initialVideoState(), videoLoop: false, takeTransition: null,
    preview: initialDeckState(),
    timer: { ...store.get().timer, running: false, startedAt: null },
    audienceTimer: { ...store.get().audienceTimer, running: false, startedAt: null } })
}

export async function restoreSessionDecks(saved: SessionCheckpoint, loaders: {
  program: (path: string, playlistId: string | null) => Promise<OpenPdfResult>
  preview: (path: string, playlistId: string | null) => Promise<OpenPdfResult>
}): Promise<OpenPdfResult> {
  clearSessionDecks()
  let result: OpenPdfResult = { ok: true }
  try {
    if (saved.program.path) {
      result = await loaders.program(saved.program.path, saved.program.playlistId)
      if (result.ok) {
        const state = store.get()
        store.patch({ currentSlide: Math.max(1, Math.min(state.totalSlides || 1, saved.program.slide)),
          sourceMuted: saved.program.sourceMuted ?? state.sourceMuted,
          video: { ...state.video, ...saved.program.video, playing: false, anchorAt: null } })
      }
    }
    // An unavailable program must not prevent a valid preview from recovering.
    if (saved.preview.path) {
      const previewResult = await loaders.preview(saved.preview.path, saved.preview.playlistId)
      if (previewResult.ok) {
        const preview = store.get().preview
        store.patchPreview({ currentSlide: Math.max(1, Math.min(preview.totalSlides || 1, saved.preview.slide)),
          sourceMuted: saved.preview.sourceMuted ?? preview.sourceMuted,
          video: { ...preview.video, ...saved.preview.video, playing: false, anchorAt: null } })
      } else if (result.ok) result = previewResult
    }
    return result
  } finally {
    store.patch({ timer: { ...saved.timer, running: false, startedAt: null },
      audienceTimer: { ...createAudienceTimer(saved.audienceTimer), elapsedMs: saved.audienceTimer.elapsedMs,
        running: false, startedAt: null } })
  }
}
