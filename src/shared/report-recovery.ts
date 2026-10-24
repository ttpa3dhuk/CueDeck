import type { AudienceTimerState } from './audience-timer.js'
import type { FileKind, TimerMode, TimerState, VideoState } from './types.js'

/** Small whitelist captured at the marker, before the operator changes anything. */
export interface ReportMarkerContext {
  atUnixMs: number
  programPath: string | null
  slide: number
  programKind?: FileKind | null
  programPlaylistId?: string | null
  previewPath: string | null
  previewSlide: number
  previewKind?: FileKind | null
  previewPlaylistId?: string | null
  video: VideoState
  videoPositionSec?: number
  previewVideo?: VideoState
  previewVideoPositionSec?: number
  keyVisualPath: string | null
  blackout?: boolean
  keyVisualVisible?: boolean
  timer?: TimerState
  timerMode?: TimerMode
  audienceTimer?: AudienceTimerState
  slideFadeMs?: number
  takeFadeMs?: number
  takeTransition?: { id: string; durationMs: number } | null
  listIndex?: number
  previewListIndex?: number
  /** Current import does not expose the original slide/animation-step map. */
  sourceSlide?: number | null
  animationStep?: number | null
}
