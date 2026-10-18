import type { FileKind, SlideMedia, VideoState } from './types'

/** Original PPTX playback policy applies only when a slide enters PROGRAM. */
export function initialSlideVideo(kind: FileKind | null, media: SlideMedia[], slide: number, muted: boolean, now = Date.now()): { video: VideoState; videoLoop: boolean } {
  const item = kind === 'pptx' ? media.find((m) => m.slide === slide) : undefined
  const playing = item?.autoPlay === true
  return { video: { playing, anchorSec: 0, anchorAt: playing ? now : null, durationSec: 0, muted },
    videoLoop: item?.loop === true }
}
