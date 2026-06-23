export type Layout = 'solo' | 'presenter-audience' | 'operator-speaker-audience'
export type Role = 'operator' | 'speaker' | 'audience'
export type DisplayMap = Partial<Record<Role, number>>

export interface TimerState {
  durationMs: number
  startedAt: number | null
  elapsedMs: number
  running: boolean
}

export type TimerMode = 'countdown' | 'stopwatch' | 'clock'

export type TimerPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export type FileKind = 'pdf' | 'image' | 'pptx' | 'video'

export type VideoTakeMode = 'play-start' | 'play-resume'

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
  /** Off-air staging deck (operator only). */
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
  audioOutputId: string | null
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

export type Unsubscribe = () => void

export interface PresenterApi {
  state: {
    get(): Promise<AppState>
    onPatch(cb: (patch: Partial<AppState>) => void): Unsubscribe
    onFull(cb: (full: AppState) => void): Unsubscribe
  }
  pdf: {
    openDialog(): Promise<OpenPdfResult>
    openPath(path: string): Promise<OpenPdfResult>
    read(): Promise<{ bytes: Uint8Array; mime: string } | null>
    reportTotal(total: number): Promise<void>
  }
  nav: {
    goto(slide: number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
  }
  /**
   * Off-air staging deck (operator only). Loading a file or selecting a playlist
   * entry lands here; `take()` promotes it to the program (audience) feed.
   */
  preview: {
    openDialog(): Promise<OpenPdfResult>
    openPath(path: string): Promise<OpenPdfResult>
    read(): Promise<{ bytes: Uint8Array; mime: string } | null>
    reportTotal(total: number): Promise<void>
    goto(slide: number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    clear(): Promise<void>
    take(): Promise<void>
    setVideoTakeMode(mode: VideoTakeMode): Promise<void>
    video: {
      toggle(): Promise<void>
      seek(sec: number): Promise<void>
      seekBy(deltaSec: number): Promise<void>
      setDuration(sec: number): Promise<void>
      ended(): Promise<void>
    }
  }
  note: {
    update(slide: number, text: string): Promise<void>
    setFontSize(px: number): Promise<void>
  }
  timer: {
    start(): Promise<void>
    pause(): Promise<void>
    reset(): Promise<void>
    setDuration(ms: number): Promise<void>
    adjust(deltaMs: number): Promise<void>
    setMode(mode: TimerMode): Promise<void>
    setPosition(pos: TimerPosition): Promise<void>
    setScale(scale: number): Promise<void>
  }
  blackout: {
    toggle(): Promise<void>
  }
  video: {
    play(): Promise<void>
    pause(): Promise<void>
    toggle(): Promise<void>
    seek(sec: number): Promise<void>
    seekBy(deltaSec: number): Promise<void>
    setDuration(sec: number): Promise<void>
    ended(): Promise<void>
    setMuted(muted: boolean): Promise<void>
    toggleMuted(): Promise<void>
  }
  audio: {
    setOutput(deviceId: string | null): Promise<void>
  }
  displays: {
    list(): Promise<DisplayInfo[]>
  }
  layout: {
    set(layout: Layout, displayMap: DisplayMap, audienceWindowed?: boolean): Promise<void>
  }
  playlist: {
    add(): Promise<PlaylistEntry[]>
    remove(id: string): Promise<void>
    reorder(ids: string[]): Promise<void>
    update(id: string, payload: { displayName?: string; speakerName?: string; durationMs?: number }): Promise<void>
    /** Load entry into the off-air preview deck (safe; does not touch the audience feed). */
    activate(id: string): Promise<OpenPdfResult>
    /** Load entry straight to the program/audience feed (double-click / Take-now). */
    activateLive(id: string): Promise<OpenPdfResult>
    setCompact(value: boolean): Promise<void>
    setAutoAdvance(value: boolean): Promise<void>
  }
  keyvisual: {
    set(): Promise<{ path: string | null }>
    clear(): Promise<void>
    read(): Promise<{ bytes: Uint8Array; mime: string } | null>
  }
  project: {
    create(): Promise<void>
    save(saveAs?: boolean): Promise<{ ok: boolean; path?: string; error?: string }>
    open(): Promise<{ ok: boolean; path?: string; error?: string }>
  }
  menu: {
    onOpenPdf(cb: () => void): Unsubscribe
    onOpenDisplaySetup(cb: () => void): Unsubscribe
    onTopologyChanged(cb: () => void): Unsubscribe
    onProjectNew(cb: () => void): Unsubscribe
    onProjectOpen(cb: () => void): Unsubscribe
    onProjectSave(cb: () => void): Unsubscribe
    onProjectSaveAs(cb: () => void): Unsubscribe
    onHelp(cb: () => void): Unsubscribe
  }
  update: {
    onAvailable(cb: (info: { newerVersion: string; url: string }) => void): Unsubscribe
  }
  session: {
    hasLast(): Promise<boolean>
    restore(): Promise<OpenPdfResult & { hadSession: boolean }>
  }
  soffice: {
    check(): Promise<boolean>
  }
  external: {
    open(url: string): Promise<void>
  }
}

declare global {
  interface Window {
    api: PresenterApi
  }
}
