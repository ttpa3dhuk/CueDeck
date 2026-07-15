import { BrowserWindow } from 'electron'
import { DEFAULT_SPEAKER_MSG_PRESETS, DEFAULT_TIMER_PRESETS } from '../shared/types.js'
import type { AppState, DeckState, Role, TimerState, VideoState } from '../shared/types.js'

// Canonical definitions live in src/shared/types.ts (shared with preload/renderer).
// Re-exported here so main-process modules keep importing them from './state.js'.
export type {
  AppState,
  DeckState,
  FileKind,
  PlaylistEntry,
  SlideMedia,
  SlideMediaRect,
  TimerMode,
  TimerPosition,
  SlideTakeMode,
  TimerState,
  UiTheme,
  VideoState,
  VideoTakeMode,
} from '../shared/types.js'
export { DEFAULT_SPEAKER_MSG_PRESETS, DEFAULT_TIMER_PRESETS } from '../shared/types.js'

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
    slideMedia: [],
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
    slideMedia: [],
    timer: { durationMs: DEFAULT_DURATION_MS, startedAt: null, elapsedMs: 0, running: false, cycles: 0 },
    timerMode: 'countdown',
    timerPosition: 'top-right',
    timerScale: 1,
    videoTakeMode: 'play-start',
    slideTakeMode: 'from-start',
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
    speakerMessage: null,
    speakerMsgPresets: [...DEFAULT_SPEAKER_MSG_PRESETS],
    timerTickEnabled: false,
    timerGongEnabled: false,
    timerLoop: false,
    timerPresets: [...DEFAULT_TIMER_PRESETS],
    clickerGlobal: false,
    clickerGlobalArrows: false,
    outputMonitorsEnabled: true,
    uiTheme: 'dark',
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
