import { BrowserWindow } from 'electron'
import type { DisplayMap, Layout, Role } from './layout.js'

export interface TimerState {
  durationMs: number
  startedAt: number | null
  elapsedMs: number
  running: boolean
}

export type TimerMode = 'countdown' | 'stopwatch' | 'clock'

export type TimerPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

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
}

const DEFAULT_DURATION_MS = 30 * 60 * 1000

export function initialVideoState(): VideoState {
  return { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: false }
}

export function initialDeckState(): DeckState {
  return {
    path: null,
    sha1: null,
    kind: null,
    totalSlides: 0,
    currentSlide: 1,
    video: initialVideoState(),
    notes: {},
    playlistId: null,
  }
}

export function initialState(): AppState {
  return {
    pdfPath: null,
    pdfSha1: null,
    fileKind: null,
    totalSlides: 0,
    currentSlide: 1,
    preview: initialDeckState(),
    blackout: false,
    video: initialVideoState(),
    timer: { durationMs: DEFAULT_DURATION_MS, startedAt: null, elapsedMs: 0, running: false },
    timerMode: 'countdown',
    timerPosition: 'top-right',
    timerScale: 1,
    videoTakeMode: 'play-start',
    notesFontSize: 18,
    notes: {},
    layout: 'solo',
    displayMap: {},
    playlist: [],
    currentPlaylistId: null,
    playlistCompact: false,
    autoAdvance: false,
    keyVisualPath: null,
    projectPath: null,
    audienceWindowed: false,
    audioOutputId: null,
  }
}

/** Position (seconds) a logical playback clock currently points at. */
function positionOf(v: VideoState): number {
  if (v.playing && v.anchorAt != null) {
    const pos = v.anchorSec + (Date.now() - v.anchorAt) / 1000
    return v.durationSec > 0 ? Math.min(pos, v.durationSec) : pos
  }
  return v.anchorSec
}

type Listener = (state: AppState, patch: Partial<AppState>) => void

export class StateStore {
  private state: AppState = initialState()
  private listeners = new Set<Listener>()
  private windows = new Map<Role, BrowserWindow>()

  get(): AppState {
    return this.state
  }

  registerWindow(role: Role, win: BrowserWindow): void {
    this.windows.set(role, win)
    win.on('closed', () => {
      if (this.windows.get(role) === win) this.windows.delete(role)
    })
    // Send full state to new window once it's ready
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('state:full', this.state)
      })
    } else {
      win.webContents.send('state:full', this.state)
    }
  }

  unregisterWindow(role: Role): void {
    this.windows.delete(role)
  }

  patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send('state:patch', partial)
      }
    }
    for (const listener of this.listeners) listener(this.state, partial)
  }

  patchNotes(slide: number, text: string): void {
    const notes = { ...this.state.notes, [slide]: text }
    this.patch({ notes })
  }

  patchTimer(timer: Partial<TimerState>): void {
    this.patch({ timer: { ...this.state.timer, ...timer } })
  }

  patchVideo(video: Partial<VideoState>): void {
    this.patch({ video: { ...this.state.video, ...video } })
  }

  patchPreview(deck: Partial<DeckState>): void {
    this.patch({ preview: { ...this.state.preview, ...deck } })
  }

  patchPreviewVideo(video: Partial<VideoState>): void {
    this.patchPreview({ video: { ...this.state.preview.video, ...video } })
  }

  /** Position the logical playback clock currently points at, in seconds. */
  videoPositionSec(): number {
    return positionOf(this.state.video)
  }

  /** Same as videoPositionSec but for the off-air preview deck's clock. */
  previewVideoPositionSec(): number {
    return positionOf(this.state.preview.video)
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const store = new StateStore()
