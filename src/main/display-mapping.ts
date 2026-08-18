import Store from 'electron-store'
import { screen } from 'electron'
import type { DisplayMap, Layout } from './layout.js'
import type { PlaylistEntry, SlideTakeMode, TimerMode, TimerPosition, UiTheme, VideoTakeMode } from './state.js'
import { DEFAULT_SPEAKER_MSG_PRESETS, DEFAULT_TIMER_PRESETS } from './state.js'

interface SavedMapping {
  layout: Layout
  displayMap: DisplayMap
}

interface PersistedShape {
  mappings: Record<string, SavedMapping>
  lastPdfPath: string | null
  lastDurationMs: number
  timerMode: TimerMode
  timerPosition: TimerPosition
  timerScale: number
  videoTakeMode: VideoTakeMode
  slideTakeMode: SlideTakeMode
  notesFontSize: number
  playlist: PlaylistEntry[]
  currentPlaylistId: string | null
  playlistCompact: boolean
  autoAdvance: boolean
  keyVisualPath: string | null
  projectPath: string | null
  audienceWindowed: boolean
  audioOutputId: string | null
  previewAudioOutputId: string | null
  /** Путь к LibreOffice, указанный оператором вручную (установка вне стандартных папок). */
  sofficePath: string | null
  timerTickEnabled: boolean
  timerGongEnabled: boolean
  timerLoop: boolean
  askLayoutOnStartup: boolean
  clickerGlobal: boolean
  clickerGlobalArrows: boolean
  speakerMsgPresets: string[]
  timerPresets: number[]
  outputMonitorsEnabled: boolean
  uiTheme: UiTheme
  /** Время прошлого запуска — по нему пропускаем плашку при быстром рестарте. */
  lastLaunchAt: number
}

const STORE_DEFAULTS: PersistedShape = {
  mappings: {},
  lastPdfPath: null,
  lastDurationMs: 30 * 60 * 1000,
  timerMode: 'countdown',
  timerPosition: 'top-right',
  timerScale: 1,
  videoTakeMode: 'play-start',
  slideTakeMode: 'from-start',
  notesFontSize: 18,
  playlist: [],
  currentPlaylistId: null,
  playlistCompact: false,
  autoAdvance: false,
  keyVisualPath: null,
  projectPath: null,
  audienceWindowed: false,
  audioOutputId: null,
  previewAudioOutputId: null,
  sofficePath: null,
  timerTickEnabled: false,
  timerGongEnabled: false,
  timerLoop: false,
  askLayoutOnStartup: true,
  clickerGlobal: false,
  clickerGlobalArrows: false,
  speakerMsgPresets: [...DEFAULT_SPEAKER_MSG_PRESETS],
  timerPresets: [...DEFAULT_TIMER_PRESETS],
  outputMonitorsEnabled: true,
  uiTheme: 'dark',
  lastLaunchAt: 0,
}

let _store: Store<PersistedShape> | null = null

function store(): Store<PersistedShape> {
  if (!_store) {
    _store = new Store<PersistedShape>({ name: 'cue-deck', defaults: STORE_DEFAULTS })
  }
  return _store
}

function topologyKey(displayIds: number[]): string {
  return [...displayIds].sort((a, b) => a - b).join(',')
}

export function currentTopologyKey(): string {
  return topologyKey(screen.getAllDisplays().map((d) => d.id))
}

export function getSavedMapping(): SavedMapping | null {
  const key = currentTopologyKey()
  const mappings = store().get('mappings')
  return mappings[key] ?? null
}

export function saveMapping(layout: Layout, displayMap: DisplayMap): void {
  const key = currentTopologyKey()
  const mappings = store().get('mappings')
  mappings[key] = { layout, displayMap }
  store().set('mappings', mappings)
}

export function getLastLaunchAt(): number {
  return store().get('lastLaunchAt')
}

export function setLastLaunchAt(ts: number): void {
  store().set('lastLaunchAt', ts)
}

export function getLastPdfPath(): string | null {
  return store().get('lastPdfPath')
}

export function setLastPdfPath(path: string | null): void {
  store().set('lastPdfPath', path)
}

export function getLastDurationMs(): number {
  return store().get('lastDurationMs')
}

export function setLastDurationMs(ms: number): void {
  store().set('lastDurationMs', ms)
}

export function getTimerMode(): TimerMode {
  return store().get('timerMode')
}

export function setTimerMode(mode: TimerMode): void {
  store().set('timerMode', mode)
}

export function getTimerPosition(): TimerPosition {
  return store().get('timerPosition')
}

export function setTimerPosition(pos: TimerPosition): void {
  store().set('timerPosition', pos)
}

export function getTimerScale(): number {
  return store().get('timerScale')
}

export function setTimerScale(scale: number): void {
  store().set('timerScale', scale)
}

export function getVideoTakeMode(): VideoTakeMode {
  return store().get('videoTakeMode')
}

export function setVideoTakeMode(mode: VideoTakeMode): void {
  store().set('videoTakeMode', mode)
}

export function getSlideTakeMode(): SlideTakeMode {
  return store().get('slideTakeMode') === 'from-current' ? 'from-current' : 'from-start'
}

export function setSlideTakeMode(mode: SlideTakeMode): void {
  store().set('slideTakeMode', mode)
}

export function getNotesFontSize(): number {
  return store().get('notesFontSize')
}

export function setNotesFontSize(px: number): void {
  store().set('notesFontSize', px)
}

export function getPlaylist(): PlaylistEntry[] {
  const raw = store().get('playlist') as unknown[]
  return raw.map((e) => {
    const v = e as Record<string, unknown>
    return {
      id: String(v.id),
      kind: (v.kind as PlaylistEntry['kind']) ?? 'pdf',
      filePath: String(v.filePath ?? v.pdfPath ?? ''),
      fileName: String(v.fileName ?? v.pdfName ?? ''),
      displayName: String(v.displayName ?? ''),
      speakerName: String(v.speakerName ?? ''),
      durationMs: Number(v.durationMs ?? 30 * 60 * 1000),
      // Необязательные поля переносим как есть: раньше они здесь терялись —
      // после перезапуска у живого входа сбрасывался режим вписывания.
      ...(v.liveFit ? { liveFit: v.liveFit as PlaylistEntry['liveFit'] } : {}),
      ...(v.loop ? { loop: true } : {}),
      ...(Array.isArray(v.items) ? { items: v.items as PlaylistEntry['items'] } : {}),
      ...(typeof v.photoSec === 'number' ? { photoSec: v.photoSec } : {}),
    }
  })
}

export function setPlaylist(playlist: PlaylistEntry[]): void {
  store().set('playlist', playlist)
}

export function getCurrentPlaylistId(): string | null {
  return store().get('currentPlaylistId')
}

export function setCurrentPlaylistId(id: string | null): void {
  store().set('currentPlaylistId', id)
}

export function getKeyVisualPath(): string | null {
  return store().get('keyVisualPath')
}

export function setKeyVisualPath(path: string | null): void {
  store().set('keyVisualPath', path)
}

export function getProjectPath(): string | null {
  return store().get('projectPath')
}

export function setProjectPath(path: string | null): void {
  store().set('projectPath', path)
}

export function getPlaylistCompact(): boolean {
  return Boolean(store().get('playlistCompact'))
}

export function setPlaylistCompact(value: boolean): void {
  store().set('playlistCompact', value)
}

export function getAutoAdvance(): boolean {
  return Boolean(store().get('autoAdvance'))
}

export function setAutoAdvance(value: boolean): void {
  store().set('autoAdvance', value)
}

export function getAudienceWindowed(): boolean {
  return Boolean(store().get('audienceWindowed'))
}

export function setAudienceWindowed(value: boolean): void {
  store().set('audienceWindowed', value)
}

export function getAudioOutputId(): string | null {
  return store().get('audioOutputId')
}

export function setAudioOutputId(id: string | null): void {
  store().set('audioOutputId', id)
}

export function getSofficePath(): string | null {
  return store().get('sofficePath')
}

export function setSofficePath(path: string | null): void {
  store().set('sofficePath', path)
}

export function getPreviewAudioOutputId(): string | null {
  return store().get('previewAudioOutputId')
}

export function setPreviewAudioOutputId(id: string | null): void {
  store().set('previewAudioOutputId', id)
}

export function getTimerTickEnabled(): boolean {
  return Boolean(store().get('timerTickEnabled'))
}

export function setTimerTickEnabled(value: boolean): void {
  store().set('timerTickEnabled', value)
}

export function getTimerGongEnabled(): boolean {
  return Boolean(store().get('timerGongEnabled'))
}

export function setTimerGongEnabled(value: boolean): void {
  store().set('timerGongEnabled', value)
}

export function getTimerLoop(): boolean {
  return Boolean(store().get('timerLoop'))
}

export function setTimerLoop(value: boolean): void {
  store().set('timerLoop', value)
}

export function getClickerGlobal(): boolean {
  return Boolean(store().get('clickerGlobal'))
}

export function setClickerGlobal(value: boolean): void {
  store().set('clickerGlobal', value)
}

export function getClickerGlobalArrows(): boolean {
  return Boolean(store().get('clickerGlobalArrows'))
}

export function setClickerGlobalArrows(value: boolean): void {
  store().set('clickerGlobalArrows', value)
}

/** Always exactly 3 non-empty texts: holes are backfilled with the defaults. */
export function getSpeakerMsgPresets(): string[] {
  const raw = store().get('speakerMsgPresets')
  const arr = Array.isArray(raw) ? raw : []
  return DEFAULT_SPEAKER_MSG_PRESETS.map((def, i) => {
    const v = typeof arr[i] === 'string' ? String(arr[i]).trim() : ''
    return v || def
  })
}

export function setSpeakerMsgPresets(presets: string[]): void {
  store().set('speakerMsgPresets', presets)
}

/** Always exactly 4 valid minute values: holes are backfilled with the defaults. */
export function getTimerPresets(): number[] {
  const raw = store().get('timerPresets')
  const arr = Array.isArray(raw) ? raw : []
  return DEFAULT_TIMER_PRESETS.map((def, i) => {
    const v = Math.floor(Number(arr[i]))
    return Number.isFinite(v) && v >= 1 && v <= 999 ? v : def
  })
}

export function setTimerPresets(presets: number[]): void {
  store().set('timerPresets', presets)
}

export function getOutputMonitorsEnabled(): boolean {
  return Boolean(store().get('outputMonitorsEnabled'))
}

export function setOutputMonitorsEnabled(value: boolean): void {
  store().set('outputMonitorsEnabled', value)
}

export function getUiTheme(): UiTheme {
  return store().get('uiTheme') === 'light' ? 'light' : 'dark'
}

export function setUiTheme(theme: UiTheme): void {
  store().set('uiTheme', theme)
}

export function getAskLayoutOnStartup(): boolean {
  return Boolean(store().get('askLayoutOnStartup'))
}

export function setAskLayoutOnStartup(value: boolean): void {
  store().set('askLayoutOnStartup', value)
}
