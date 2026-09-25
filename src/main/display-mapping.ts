import Store from 'electron-store'
import { screen } from 'electron'
import type { DisplayMap, Layout } from './layout.js'
import type { PlaylistEntry, RemoteSettings, SlideTakeMode, TimerMode, TimerPosition, UiTheme, VideoTakeMode } from './state.js'
import { DEFAULT_SPEAKER_MSG_PRESETS, DEFAULT_TIMER_PRESETS } from './state.js'
import { DEFAULT_REMOTE_SETTINGS } from '../shared/types.js'
import { EN } from '../shared/i18n-en.js'
import { parseLang, t, type Lang } from '../shared/i18n.js'

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
  timerFree: { x: number; y: number }
  timerColor: string | null
  timerWarnColors: boolean
  speakerLayout: { sidebarPct: number; nextPct: number | null }
  speakerMsgLayout: { pos: { x: number; y: number } | null; scale: number }
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
  /**
   * Язык интерфейса. Нет в файле — ещё не выбирали: при запуске спросим
   * (lang-dialog.ts). В STORE_DEFAULTS его нет сознательно — иначе он
   * записался бы в файл сам и вопрос не прозвучал бы никогда.
   */
  uiLang?: Lang
  /** Внешнее управление (remote/server.ts). */
  remote: RemoteSettings
  /** MIDI-входы, которые слушает CueDeck — имена устройств («Настройки → MIDI»). */
  midiInputs: string[]
  /** Время прошлого запуска — по нему пропускаем плашку при быстром рестарте. */
  lastLaunchAt: number
  /**
   * Штатно ли завершилась прошлая сессия (diag.ts): false на старте, true перед
   * app.exit. Запустились с false — значит в прошлый раз упали или убили.
   */
  cleanExit: boolean
}

const STORE_DEFAULTS: PersistedShape = {
  mappings: {},
  lastPdfPath: null,
  lastDurationMs: 30 * 60 * 1000,
  timerMode: 'countdown',
  timerPosition: 'top-right',
  timerScale: 1,
  timerFree: { x: 0.85, y: 0.12 },
  timerColor: null,
  timerWarnColors: true,
  speakerLayout: { sidebarPct: 37, nextPct: null },
  speakerMsgLayout: { pos: null, scale: 1 },
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
  // Новые установки — светлая (Азат 2026-09-24). У старых тема уже записана в
  // файл настроек явно, их это не переключит.
  uiTheme: 'light',
  remote: { ...DEFAULT_REMOTE_SETTINGS },
  midiInputs: [],
  lastLaunchAt: 0,
  cleanExit: true,
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

export function getCleanExit(): boolean {
  return store().get('cleanExit')
}

export function setCleanExit(value: boolean): void {
  store().set('cleanExit', value)
}

/** Все сохранённые настройки целиком — для отчёта о проблеме (diag.ts). */
export function dumpPrefs(): PersistedShape {
  return store().store
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

const clamp01 = (v: unknown, def: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : def
}

export function getTimerFree(): { x: number; y: number } {
  const raw = (store().get('timerFree') ?? {}) as { x?: unknown; y?: unknown }
  return { x: clamp01(raw.x, 0.85), y: clamp01(raw.y, 0.12) }
}

export function setTimerFree(pos: { x: number; y: number }): void {
  store().set('timerFree', pos)
}

const HEX = /^#[0-9a-f]{6}$/i

export function getTimerColor(): string | null {
  const v = store().get('timerColor')
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null
}

export function setTimerColor(color: string | null): void {
  store().set('timerColor', color)
}

export function validTimerColor(v: unknown): string | null {
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null
}

export function getTimerWarnColors(): boolean {
  return store().get('timerWarnColors') !== false
}

export function setTimerWarnColors(v: boolean): void {
  store().set('timerWarnColors', v)
}

const clampRange = (v: unknown, min: number, max: number, def: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : def
}

export function sanitizeSpeakerLayout(v: unknown): { sidebarPct: number; nextPct: number | null } {
  const raw = (v ?? {}) as { sidebarPct?: unknown; nextPct?: unknown }
  return {
    sidebarPct: clampRange(raw.sidebarPct, 18, 60, 37),
    nextPct: raw.nextPct === null || raw.nextPct === undefined ? null : clampRange(raw.nextPct, 15, 85, 50),
  }
}

export function getSpeakerLayout(): { sidebarPct: number; nextPct: number | null } {
  return sanitizeSpeakerLayout(store().get('speakerLayout'))
}

export function setSpeakerLayout(v: { sidebarPct: number; nextPct: number | null }): void {
  store().set('speakerLayout', v)
}

export function sanitizeSpeakerMsgLayout(v: unknown): { pos: { x: number; y: number } | null; scale: number } {
  const raw = (v ?? {}) as { pos?: { x?: unknown; y?: unknown } | null; scale?: unknown }
  const pos = raw.pos && typeof raw.pos === 'object'
    ? { x: Math.round(clamp01(raw.pos.x, 0.5) * 1000) / 1000, y: Math.round(clamp01(raw.pos.y, 0.15) * 1000) / 1000 }
    : null
  return { pos, scale: clampRange(raw.scale, 0.3, 3, 1) }
}

export function getSpeakerMsgLayout(): { pos: { x: number; y: number } | null; scale: number } {
  return sanitizeSpeakerMsgLayout(store().get('speakerMsgLayout'))
}

export function setSpeakerMsgLayout(v: { pos: { x: number; y: number } | null; scale: number }): void {
  store().set('speakerMsgLayout', v)
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
    // Заводской текст (на любом из языков) — показываем на текущем:
    // «Заканчивайте» у английского интерфейса становится «Wrap up».
    return !v || v === def || v === EN[def] ? t(def) : v
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
  return store().get('uiTheme') === 'dark' ? 'dark' : 'light'
}

export function setUiTheme(theme: UiTheme): void {
  store().set('uiTheme', theme)
}

/** Выбранный язык интерфейса; null — ещё не выбирали (первый запуск). */
export function getUiLang(): Lang | null {
  return parseLang(store().get('uiLang'))
}

export function setUiLang(lang: Lang): void {
  store().set('uiLang', lang)
}


/** Порт вне 1024–65535 или мусор в файле настроек → дефолт. */
function validPort(v: unknown, def: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : def
}

export function getRemoteSettings(): RemoteSettings {
  const raw = (store().get('remote') ?? {}) as Partial<RemoteSettings>
  return {
    enabled: raw.enabled === true,
    httpPort: validPort(raw.httpPort, DEFAULT_REMOTE_SETTINGS.httpPort),
    oscPort: validPort(raw.oscPort, DEFAULT_REMOTE_SETTINGS.oscPort),
    lan: raw.lan === true,
    companionPush: raw.companionPush !== false,
    companionHost: validHost(raw.companionHost) ?? DEFAULT_REMOTE_SETTINGS.companionHost,
  }
}

/** `хост:порт` без схемы и пути; мусор → null. */
export function validHost(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return /^[a-z0-9.-]+(:\d{2,5})?$/i.test(t) ? t : null
}

export function setRemoteSettings(value: RemoteSettings): void {
  store().set('remote', value)
}

export function getAskLayoutOnStartup(): boolean {
  return Boolean(store().get('askLayoutOnStartup'))
}

export function setAskLayoutOnStartup(value: boolean): void {
  store().set('askLayoutOnStartup', value)
}

export function getMidiInputs(): string[] {
  const raw = store().get('midiInputs')
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

export function setMidiInputs(names: string[]): void {
  store().set('midiInputs', [...new Set(names.filter((x) => typeof x === 'string' && x.length > 0))].slice(0, 32))
}
