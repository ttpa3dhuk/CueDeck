import type { FileKind, SlideAudioCue, SlideMedia, VideoState } from './types'

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
  return typeof cue.file === 'string' && cue.file.toLowerCase().endsWith('.mp3') &&
    !cue.file.includes('..') && !cue.file.includes('/') && !cue.file.includes('\\') && !cue.file.includes('\0') &&
    typeof cue.volume === 'number' && cue.volume >= 0 && cue.volume <= 1 &&
    typeof cue.loop === 'boolean' &&
    (cue.delayMs === undefined || Number.isInteger(cue.delayMs) && cue.delayMs >= 0 && cue.delayMs <= 60_000) &&
    (cue.trigger === 'enter' || cue.trigger === 'menu' || cue.trigger === 'click' && typeof cue.shape === 'string' && /^\d+$/.test(cue.shape))
}
