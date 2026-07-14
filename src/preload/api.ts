// Canonical state types live in src/shared/types.ts (shared with the main
// process). Renderers keep importing them from this module.
import type {
  AppState,
  DisplayInfo,
  DisplayMap,
  Layout,
  MonitorRole,
  OpenPdfResult,
  PlaylistEntry,
  TimerMode,
  TimerPosition,
  UiTheme,
  VideoTakeMode,
} from '../shared/types.js'

export { DONATE_URL } from '../shared/types.js'

export type {
  AppState,
  DeckState,
  DisplayInfo,
  DisplayMap,
  FileKind,
  Layout,
  MonitorRole,
  OpenPdfResult,
  PlaylistEntry,
  Role,
  SlideMedia,
  SlideMediaRect,
  TimerMode,
  TimerPosition,
  TimerState,
  UiTheme,
  VideoState,
  VideoTakeMode,
} from '../shared/types.js'

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
  clicker: {
    /** Global PgUp/PgDn clicker. Resolves to what actually got enabled (registration can fail). */
    setGlobal(value: boolean): Promise<boolean>
    /** Also grab ←/→ globally (Spotlight-style clickers). Resolves to the applied value. */
    setGlobalArrows(value: boolean): Promise<boolean>
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
    /** Sound cue on the operator: ticks in the last 10s of a countdown. */
    setTickSound(enabled: boolean): Promise<void>
    /** Sound cue on the operator: gong at zero / on every loop wrap. */
    setGongSound(enabled: boolean): Promise<void>
    /** Loop mode: countdown restarts automatically on zero. */
    setLoop(enabled: boolean): Promise<void>
  }
  blackout: {
    toggle(): Promise<void>
  }
  speakerMessage: {
    /** Show a blinking message on the speaker monitor; null/'' clears it. */
    set(text: string | null): Promise<void>
    /** Replace the texts of the three preset buttons (user-editable, persisted). */
    setPresets(presets: string[]): Promise<void>
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
    getAskOnStartup(): Promise<boolean>
    setAskOnStartup(value: boolean): Promise<void>
  }
  monitor: {
    /** Мониторы выходов под эфиром: вкл/выкл (персистится). */
    setEnabled(value: boolean): Promise<void>
    /** JPEG-кадры окон суфлёра/зала (~2 fps); приходят только оператору. */
    onFrame(cb: (frame: { role: MonitorRole; dataUrl: string }) => void): Unsubscribe
  }
  ui: {
    /** Тема окна оператора (персистится). */
    setTheme(theme: UiTheme): Promise<void>
  }
  files: {
    /** Filesystem path of a dropped/picked File (webUtils.getPathForFile). */
    pathFor(file: File): string
  }
  playlist: {
    add(): Promise<PlaylistEntry[]>
    /** Append files by path (drag & drop); unsupported paths are skipped. */
    addPaths(paths: string[]): Promise<PlaylistEntry[]>
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
