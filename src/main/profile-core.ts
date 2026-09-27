/**
 * Профили площадки — ядро без Electron (тесты: tests/profiles.test.ts).
 *
 * Профиль — снимок настроек под конкретный зал: экраны, звук, суфлёр, таймер,
 * кликер, внешнее управление, MIDI (состав — VenueProfileSettings в
 * shared/types.ts). Живёт списком в настройках программы и выгружается файлом
 * `.cueprofile` — перенести на другой ноут или отдать коллеге.
 *
 * Здесь только разбор и проверка. Применяет профиль profiles.ts — через те же
 * обработчики ipc, что кнопки «Настроек», своей логики настроек здесь нет.
 */
import type {
  Layout,
  ProfileAudioOutput,
  ProfileGroup,
  RemoteSettings,
  SlideTakeMode,
  TimerMode,
  TimerPosition,
  VenueProfile,
  VenueProfileSettings,
  VideoTakeMode,
} from '../shared/types.js'
import { DEFAULT_REMOTE_SETTINGS } from '../shared/types.js'

export const PROFILE_EXT = 'cueprofile'
export const PROFILE_SCHEMA = 1
/** Сколько профилей держим в списке — защита файла настроек от мусора при импорте. */
export const MAX_PROFILES = 100

const LAYOUTS: readonly Layout[] = ['solo', 'presenter-audience', 'operator-speaker-audience']
const TIMER_MODES: readonly TimerMode[] = ['countdown', 'stopwatch', 'clock']
const TIMER_POSITIONS: readonly TimerPosition[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'hidden',
  'full',
  'full-noflash',
  'free',
]
const VIDEO_TAKE: readonly VideoTakeMode[] = ['play-start', 'play-resume', 'hold-first']
const SLIDE_TAKE: readonly SlideTakeMode[] = ['from-start', 'from-current']

/** Порядок — как в окне «Настройки». */
export const PROFILE_GROUPS: readonly ProfileGroup[] = [
  'screens',
  'audio',
  'prompter',
  'timer',
  'presets',
  'take',
  'clicker',
  'remote',
  'midi',
]

/** Какие поля настроек входят в группу. Каждое поле — ровно в одной группе (тест это держит). */
export const GROUP_KEYS: Record<ProfileGroup, readonly (keyof VenueProfileSettings)[]> = {
  screens: ['layout', 'audienceWindowed', 'outputMonitorsEnabled'],
  audio: ['audioMain', 'audioPreview'],
  prompter: ['timerPosition', 'timerScale', 'timerFree', 'timerColor', 'timerWarnColors', 'speakerLayout', 'speakerMsgLayout'],
  timer: ['timerMode', 'timerTickEnabled', 'timerGongEnabled', 'timerLoop'],
  presets: ['timerPresets', 'speakerMsgPresets'],
  take: ['videoTakeMode', 'slideTakeMode', 'autoAdvance'],
  clicker: ['clickerGlobal', 'clickerGlobalArrows'],
  remote: ['remote'],
  midi: ['midiInputs'],
}

/** Список групп из чего угодно. Нет поля (профиль до групп) → все группы. */
export function sanitizeGroups(raw: unknown): ProfileGroup[] {
  if (!Array.isArray(raw)) return [...PROFILE_GROUPS]
  return PROFILE_GROUPS.filter((g) => raw.includes(g))
}

/**
 * «Обновить» с выбранными группами: эти группы берём из текущих настроек,
 * остальное в профиле остаётся как было.
 */
export function mergeSettings(
  old: VenueProfileSettings,
  current: VenueProfileSettings,
  groups: readonly ProfileGroup[],
): VenueProfileSettings {
  const out: Record<string, unknown> = { ...old }
  for (const g of groups) for (const k of GROUP_KEYS[g]) out[k] = current[k]
  return out as unknown as VenueProfileSettings
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T =>
  list.includes(v as T) ? (v as T) : def
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)
const num = (v: unknown, min: number, max: number, def: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, n)) : def
}
const point = (v: unknown, def: { x: number; y: number }): { x: number; y: number } =>
  isObj(v) ? { x: num(v.x, 0, 1, def.x), y: num(v.y, 0, 1, def.y) } : { ...def }

function audio(v: unknown): ProfileAudioOutput | null {
  if (!isObj(v) || typeof v.label !== 'string' || !v.label.trim()) return null
  return { id: typeof v.id === 'string' ? v.id : '', label: v.label.trim().slice(0, 200) }
}

function remote(v: unknown): RemoteSettings {
  const r = isObj(v) ? v : {}
  const d = DEFAULT_REMOTE_SETTINGS
  const port = (p: unknown, def: number): number => {
    const n = Math.floor(Number(p))
    return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : def
  }
  const host = typeof r.companionHost === 'string' && /^[a-z0-9.-]+(:\d{2,5})?$/i.test(r.companionHost.trim())
    ? r.companionHost.trim()
    : d.companionHost
  return {
    enabled: bool(r.enabled, d.enabled),
    httpPort: port(r.httpPort, d.httpPort),
    oscPort: port(r.oscPort, d.oscPort),
    lan: bool(r.lan, d.lan),
    companionPush: bool(r.companionPush, d.companionPush),
    companionHost: host,
  }
}

/**
 * Настройки из чего угодно (файл с другой машины, старая версия схемы,
 * ручная правка) → валидный набор. Чего нет или мусор — умолчание, как у
 * свежей установки. Тонкие пределы (масштаб, проценты колонок) дожмут
 * обработчики ipc при применении.
 */
export function sanitizeSettings(raw: unknown): VenueProfileSettings {
  const s = isObj(raw) ? raw : {}
  const speaker = isObj(s.speakerLayout) ? s.speakerLayout : {}
  const msg = isObj(s.speakerMsgLayout) ? s.speakerMsgLayout : {}
  const color = typeof s.timerColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.timerColor) ? s.timerColor : null
  return {
    layout: oneOf(s.layout, LAYOUTS, 'operator-speaker-audience'),
    audienceWindowed: bool(s.audienceWindowed, false),
    outputMonitorsEnabled: bool(s.outputMonitorsEnabled, true),
    audioMain: audio(s.audioMain),
    audioPreview: audio(s.audioPreview),
    timerMode: oneOf(s.timerMode, TIMER_MODES, 'countdown'),
    timerPosition: oneOf(s.timerPosition, TIMER_POSITIONS, 'top-right'),
    timerScale: num(s.timerScale, 0.3, 4, 1),
    timerFree: point(s.timerFree, { x: 0.85, y: 0.12 }),
    timerColor: color,
    timerWarnColors: bool(s.timerWarnColors, true),
    timerTickEnabled: bool(s.timerTickEnabled, false),
    timerGongEnabled: bool(s.timerGongEnabled, false),
    timerLoop: bool(s.timerLoop, false),
    timerPresets: Array.isArray(s.timerPresets)
      ? s.timerPresets.slice(0, 8).map((m) => Math.floor(num(m, 0, 999, 0)))
      : [],
    speakerLayout: {
      sidebarPct: num(speaker.sidebarPct, 18, 60, 37),
      nextPct: speaker.nextPct === null || speaker.nextPct === undefined ? null : num(speaker.nextPct, 15, 85, 50),
    },
    speakerMsgLayout: {
      pos: msg.pos === null || msg.pos === undefined ? null : point(msg.pos, { x: 0.5, y: 0.12 }),
      scale: num(msg.scale, 0.3, 3, 1),
    },
    speakerMsgPresets: Array.isArray(s.speakerMsgPresets)
      ? s.speakerMsgPresets.slice(0, 12).map((x) => (typeof x === 'string' ? x.slice(0, 60) : ''))
      : [],
    videoTakeMode: oneOf(s.videoTakeMode, VIDEO_TAKE, 'play-start'),
    slideTakeMode: oneOf(s.slideTakeMode, SLIDE_TAKE, 'from-start'),
    autoAdvance: bool(s.autoAdvance, false),
    clickerGlobal: bool(s.clickerGlobal, false),
    clickerGlobalArrows: bool(s.clickerGlobalArrows, false),
    remote: remote(s.remote),
    midiInputs: Array.isArray(s.midiInputs)
      ? [...new Set(s.midiInputs.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, 32)
      : [],
  }
}

/** Имя профиля: без переводов строк, не пустое, не длиннее 80 символов. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const n = v.replace(/\s+/g, ' ').trim().slice(0, 80)
  return n || null
}

/** Профиль из списка настроек; битый → null (его просто не показываем). */
export function sanitizeProfile(raw: unknown): VenueProfile | null {
  if (!isObj(raw)) return null
  const name = cleanName(raw.name)
  if (!name || typeof raw.id !== 'string' || !raw.id) return null
  return {
    id: raw.id,
    name,
    groups: sanitizeGroups(raw.groups),
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    settings: sanitizeSettings(raw.settings),
  }
}

export function sanitizeProfileList(raw: unknown): VenueProfile[] {
  if (!Array.isArray(raw)) return []
  return raw.map(sanitizeProfile).filter((p): p is VenueProfile => p !== null).slice(0, MAX_PROFILES)
}

/** Содержимое файла `.cueprofile`. id внутрь не пишем — у каждой установки свой. */
export function serializeProfileFile(p: VenueProfile, appVersion: string): string {
  const file = {
    app: 'CueDeck',
    kind: 'venue-profile',
    schemaVersion: PROFILE_SCHEMA,
    appVersion,
    name: p.name,
    savedAt: p.savedAt,
    groups: p.groups,
    settings: p.settings,
  }
  return JSON.stringify(file, null, 2) + '\n'
}

export type ParsedProfileFile = { ok: true; name: string; savedAt: string; groups: ProfileGroup[]; settings: VenueProfileSettings } | { ok: false; error: 'json' | 'kind' | 'newer' }

/**
 * Текст файла → профиль. Ошибки — кодами, текст для человека подбирает
 * вызывающий (он знает язык интерфейса).
 */
export function parseProfileFile(text: string, fallbackName: string): ParsedProfileFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'json' }
  }
  if (!isObj(raw) || raw.kind !== 'venue-profile') return { ok: false, error: 'kind' }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > PROFILE_SCHEMA) return { ok: false, error: 'newer' }
  return {
    ok: true,
    name: cleanName(raw.name) ?? cleanName(fallbackName) ?? 'Profile',
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    groups: sanitizeGroups(raw.groups),
    settings: sanitizeSettings(raw.settings),
  }
}

/** «Зал 2» занят → «Зал 2 (2)», «Зал 2 (3)»… Сравнение без регистра. */
export function uniqueProfileName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

/** Имя файла из имени профиля: без символов, запрещённых в Windows и macOS. */
export function profileFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || 'profile'
  return `${base}.${PROFILE_EXT}`
}
