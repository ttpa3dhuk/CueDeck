/**
 * Single source of truth for the state types shared by the main process and
 * the preload/renderer side. Type-only module — safe to import from any
 * process (everything is erased at compile time).
 *
 * main:    src/main/state.ts, layout.ts, ipc.ts re-export from here.
 * preload: src/preload/api.ts re-exports from here (renderers import from it).
 */

export type Layout = 'solo' | 'presenter-audience' | 'operator-speaker-audience'

export type Role = 'operator' | 'speaker' | 'audience'

export type DisplayMap = Partial<Record<Role, number>>

export interface TimerState {
  durationMs: number
  startedAt: number | null
  elapsedMs: number
  running: boolean
  /**
   * Completed loop rounds (timerLoop mode). Main increments it when the
   * countdown wraps and restarts; renderers watch the change to fire the
   * gong/flash even if they never observed remaining <= 0 between ticks.
   */
  cycles: number
}

export type TimerMode = 'countdown' | 'stopwatch' | 'clock'

// 'hidden' убирает таймер с суфлёра совсем — когда суфлёрский сигнал идёт
// через vMix и режиссёр накладывает свой таймер поверх.
export type TimerPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'hidden'

export type FileKind = 'pdf' | 'image' | 'pptx' | 'video'

/**
 * What happens to a video clip when it is taken from preview to program:
 * always autoplay, either from 0 or resuming at the preview scrub position.
 */
export type VideoTakeMode = 'play-start' | 'play-resume'

/**
 * Logical playback clock shared across all windows (like TimerState).
 * Current position is derived, never stored as a moving value:
 *   playing && anchorAt → anchorSec + (now - anchorAt) / 1000
 *   otherwise           → anchorSec
 * This keeps operator preview and audience output in sync without
 * streaming currentTime over IPC on every frame.
 */
export interface VideoState {
  playing: boolean
  anchorSec: number
  anchorAt: number | null
  durationSec: number
  muted: boolean
}

export interface PlaylistEntry {
  id: string
  kind: FileKind
  filePath: string
  fileName: string
  /** User-given label shown in the playlist instead of fileName. '' → use fileName. */
  displayName: string
  speakerName: string
  durationMs: number
}

/**
 * A single loaded deck (file + position). The top-level AppState fields
 * (pdfPath/fileKind/currentSlide/video/notes/currentPlaylistId) ARE the PROGRAM
 * deck — what the audience sees, driven by the clicker. `AppState.preview` is a
 * second, independent deck the operator stages off-air; `take` copies it into the
 * program fields. Keeping program top-level avoids touching audience/speaker code.
 */
export interface DeckState {
  path: string | null
  sha1: string | null
  kind: FileKind | null
  totalSlides: number
  currentSlide: number
  video: VideoState
  notes: Record<number, string>
  playlistId: string | null
}

export interface AppState {
  pdfPath: string | null
  pdfSha1: string | null
  fileKind: FileKind | null
  totalSlides: number
  currentSlide: number
  /** Off-air staging deck (operator only). `take` promotes it to program. */
  preview: DeckState
  blackout: boolean
  video: VideoState
  timer: TimerState
  timerMode: TimerMode
  timerPosition: TimerPosition
  timerScale: number
  videoTakeMode: VideoTakeMode
  notesFontSize: number
  notes: Record<number, string>
  layout: Layout
  displayMap: DisplayMap
  playlist: PlaylistEntry[]
  currentPlaylistId: string | null
  playlistCompact: boolean
  autoAdvance: boolean
  keyVisualPath: string | null
  projectPath: string | null
  audienceWindowed: boolean
  /** Output device id for video sound (setSinkId). null = system default. */
  audioOutputId: string | null
  /** Flash message on the speaker monitor; stays (blinking) until cleared. null = none. */
  speakerMessage: string | null
  /** Sound cue on the operator: ticks in the last 10s of a countdown. */
  timerTickEnabled: boolean
  /** Sound cue on the operator: gong when the countdown hits zero / wraps a loop round. */
  timerGongEnabled: boolean
  /** Loop mode: countdown restarts automatically on zero (15/30-second rounds etc.). */
  timerLoop: boolean
}

export interface DisplayInfo {
  id: number
  label: string
  internal: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

export interface OpenPdfResult {
  ok: boolean
  path?: string
  totalSlides?: number
  sha1?: string
  sha1Mismatch?: boolean
  cancelled?: boolean
  error?: string
  kind?: FileKind
}
