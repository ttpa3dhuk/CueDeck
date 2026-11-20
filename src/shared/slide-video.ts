import type { AppState, FileKind, SlideAudioCue, SlideMedia, VideoState } from './types'

/** Original PPTX playback policy applies only when a slide enters PROGRAM. */
export function initialSlideVideo(kind: FileKind | null, media: SlideMedia[], slide: number, muted: boolean, now = Date.now()): { video: VideoState; videoLoop: boolean } {
  const item = kind === 'pptx' ? media.find((m) => m.slide === slide && m.kind === undefined) : undefined
  const playing = item?.autoPlay === true
  return { video: { playing, anchorSec: 0, anchorAt: playing ? now : null, durationSec: 0, muted },
    videoLoop: item?.loop === true }
}

export function validSlideAudioCue(value: unknown): value is SlideAudioCue {
  if (!value || typeof value !== 'object') return false
  const cue = value as Partial<SlideAudioCue>
  return typeof cue.file === 'string' && /\.(?:mp3|m4a|wav)$/i.test(cue.file) &&
    !cue.file.includes('..') && !cue.file.includes('/') && !cue.file.includes('\\') && !cue.file.includes('\0') &&
    typeof cue.volume === 'number' && cue.volume >= 0 && cue.volume <= 1 &&
    typeof cue.loop === 'boolean' &&
    (cue.delayMs === undefined || Number.isInteger(cue.delayMs) && cue.delayMs >= 0 && cue.delayMs <= 60_000) &&
    (cue.trigger === 'enter' || cue.trigger === 'menu' ||
      cue.trigger === 'click' && typeof cue.shape === 'string' && /^\d+$/.test(cue.shape) ||
      cue.trigger === 'advance' && typeof cue.step === 'number' && Number.isInteger(cue.step) && cue.step >= 1 && cue.step <= 1000)
}

/** An audio-only click group consumes one Next press before slide navigation. */
export function slideAudioAdvancePatch(state: Pick<AppState,
  'fileKind' | 'pdfSha1' | 'currentSlide' | 'slideMedia' | 'slideAdvanceStep' | 'takeTransition'>,
  id: string, now = Date.now()): Partial<AppState> | null {
  if (state.fileKind !== 'pptx' || !state.pdfSha1) return null
  const step = (state.slideAdvanceStep ?? 0) + 1
  const cues = state.slideMedia.filter(media => media.slide === state.currentSlide)
    .flatMap(media => media.audio ?? []).filter(cue => cue.trigger === 'advance' && cue.step === step)
  if (!cues.length) return null
  return { slideAdvanceStep: step,
    slideAudioClick: { id, sha: state.pdfSha1, slide: state.currentSlide,
      takeId: state.takeTransition?.id, at: now, cues } }
}
