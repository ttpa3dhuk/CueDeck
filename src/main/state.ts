import { DEFAULT_TEST_SCREEN, hasTestScreenContent } from '../shared/test-screen.js'
import { DEFAULT_TIMER_ADJUSTMENTS } from '../shared/timer-controls.js'
import { DEFAULT_STARTUP_SETTINGS } from '../shared/startup-settings.js'
import { DEFAULT_TAKE_FADE_MS } from '../shared/take-transition.js'
import { BrowserWindow } from 'electron'
import { DEFAULT_OMT_SETTINGS, OMT_OUTPUT_OFF, DEFAULT_REMOTE_SETTINGS, DEFAULT_STREAM_SETTINGS, DEFAULT_SPEAKER_MSG_PRESETS, DEFAULT_TIMER_PRESETS, defaultSyphonStatus } from '../shared/types.js'
import type { AppState, DeckState, Role, TimerState, VideoState } from '../shared/types.js'
import { createAudienceTimer } from '../shared/audience-timer.js'

// Canonical definitions live in src/shared/types.ts (shared with preload/renderer).
// Re-exported here so main-process modules keep importing them from './state.js'.
export type {
  AppState,
  DeckState,
  FileKind,
  ListItem,
  ListMode,
  LiveFit,
  PlaylistEntry,
  PlaylistFolder,
  RemoteSettings,
  RemoteStatus,
  SlideMedia,
  SlideMediaRect,
  TimerMode,
  TimerPosition,
  SlideTakeMode,
  StreamDestination,
  StreamSettings,
  StreamStatus,
  TimerState,
  UiTheme,
  VideoState,
  VenueProfile,
  VideoTakeMode,
} from '../shared/types.js'
export { DEFAULT_SPEAKER_MSG_PRESETS, DEFAULT_TIMER_PRESETS } from '../shared/types.js'

const DEFAULT_DURATION_MS = 30 * 60 * 1000

export function initialVideoState(): VideoState {
  return { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: false, range: null, seekSeq: 0 }
}

export function initialDeckState(): DeckState {
  return {
    recoveryTake: false,
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
    startup: { ...DEFAULT_STARTUP_SETTINGS },
    recoveryStartup: false,
    autosaveError: null,
    audienceOutputEnabled: true,
    testScreen: { ...DEFAULT_TEST_SCREEN },
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
    audienceTimer: createAudienceTimer(),
    materialSettings: { defaultDurationMs: 0, autoStartTimer: false },
    timerMode: 'countdown',
    timerPosition: 'top-right',
    timerScale: 1,
    timerFree: { x: 0.85, y: 0.12 },
    timerFont: 'system',
    timerColor: null,
    timerWarnColors: true,
    speakerToolbarScale: 1,
    speakerLayout: { sidebarPct: 37, nextPct: null },
    speakerMsgLayout: { pos: null, scale: 1 },
    videoTakeMode: 'play-start',
    slideTakeMode: 'from-start',
    takeFadeMs: DEFAULT_TAKE_FADE_MS,
    takeTransition: null,
    notesFontSize: 18,
    notes: {},
    layout: 'solo',
    displayMap: {},
    videoLoop: false,
    listIndex: -1,
    listPos: -1,
    previewListIndex: -1,
    playlist: [],
    playlistFolders: [],
    missingIds: [],
    missingPaths: [],
    fontIssues: {},
    currentPlaylistId: null,
    playlistCompact: false,
    autoAdvance: false,
    keyVisualPath: null,
    projectPath: null,
    projectTransfer: null,
    audienceWindowed: false,
    audienceAlwaysOnTop: true,
    audioOutputId: null,
    previewAudioOutputId: null,
    speakerMessage: null,
    speakerMsgPresets: [...DEFAULT_SPEAKER_MSG_PRESETS],
    timerTickEnabled: false,
    timerGongEnabled: false,
    timerLoop: false,
    timerAdjustments: [...DEFAULT_TIMER_ADJUSTMENTS],
    timerPresets: [...DEFAULT_TIMER_PRESETS],
    playlistDoubleClickTake: false,
    clickerGlobal: false,
    clickerGlobalArrows: false,
    outputMonitorsEnabled: true,
    uiTheme: 'light',
    remote: {
      ...DEFAULT_REMOTE_SETTINGS,
      http: 'off',
      osc: 'off',
      httpError: null,
      oscError: null,
      hosts: [],
      companion: 'off',
      companionError: null,
    },
    stream: {
      settings: { ...DEFAULT_STREAM_SETTINGS, destinations: [] },
      running: false,
      startedAt: null,
      encoder: 'off',
      encoderError: null,
      fps: 0,
      destinations: [],
      warn: false,
      reasons: [],
      encoderSkipped: 0,
      capture: false,
      log: [],
    },
    omt: {
      enabled: { ...DEFAULT_OMT_SETTINGS.enabled },
      names: { ...DEFAULT_OMT_SETTINGS.names },
      sizes: { ...DEFAULT_OMT_SETTINGS.sizes },
      fps: { ...DEFAULT_OMT_SETTINGS.fps },
      programAudio: DEFAULT_OMT_SETTINGS.programAudio,
      timerMessage: DEFAULT_OMT_SETTINGS.timerMessage,
      available: null,
      error: null,
      outputs: {
        timer: { ...OMT_OUTPUT_OFF },
        program: { ...OMT_OUTPUT_OFF },
        prompter: { ...OMT_OUTPUT_OFF },
      },
    },
    syphon: defaultSyphonStatus(),
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

/** Окна, которым рассылается состояние: роли раскладки + служебные (оверлей OMT). */
export type WindowKey = Role | 'omt-timer'

type Listener = (state: AppState, patch: Partial<AppState>) => void

export class StateStore {
  private state: AppState = initialState()
  private listeners = new Set<Listener>()
  private windows = new Map<WindowKey, BrowserWindow>()

  get(): AppState {
    return this.state
  }

  registerWindow(role: WindowKey, win: BrowserWindow): void {
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

  unregisterWindow(role: WindowKey): void {
    this.windows.delete(role)
  }

  registeredWindow(role: WindowKey): BrowserWindow | undefined {
    const win = this.windows.get(role)
    return win && !win.isDestroyed() ? win : undefined
  }

  patch(partial: Partial<AppState>): void {
    // Legacy remote/profile fields mirror the hall timer after the controls moved there.
    if (partial.audienceTimer) {
      partial = { ...partial, timerTickEnabled: partial.audienceTimer.tickEnabled,
        timerGongEnabled: partial.audienceTimer.gongEnabled, timerLoop: partial.audienceTimer.loop }
    }

    // Once material has appeared, clearing it or recreating a window must never
    // resurrect the startup logo. Apply this gate in the same broadcast as content.
    const merged = { ...this.state, ...partial }
    if (merged.testScreen.automatic && hasTestScreenContent(merged)) {
      partial = { ...partial, testScreen: { ...merged.testScreen, automatic: false } }
    }
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
    const current = this.state.video
    const next = { ...current, ...video }
    // An explicit position write must reach every window even when it is only
    // one frame away from the current element time (drift correction ignores it).
    if (Object.hasOwn(video, 'anchorSec')) next.seekSeq = (current.seekSeq ?? 0) + 1
    this.patch({ video: next })
  }

  patchPreview(deck: Partial<DeckState>): void {
    this.patch({ preview: { ...this.state.preview, ...deck } })
  }

  patchPreviewVideo(video: Partial<VideoState>): void {
    const current = this.state.preview.video
    const next = { ...current, ...video }
    if (Object.hasOwn(video, 'anchorSec')) next.seekSeq = (current.seekSeq ?? 0) + 1
    this.patchPreview({ video: next })
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
