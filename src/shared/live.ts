/**
 * Живой вход (2.13) — внешний источник картинки: USB-капчер HDMI (AVMatrix,
 * ATEM Mini / Web Presenter, Cam Link), веб-камера, айфон по Continuity.
 * Кейс: на площадке ведущий или диджей приходит со своим ноутом и запускает
 * контент только у себя — оператор берёт его HDMI через капчер и выдаёт в зал
 * наравне с презентациями из плейлиста.
 *
 * Всё такое устройство в системе выглядит как обычная веб-камера (UVC), так что
 * Chromium берёт его через getUserMedia — без нативных аддонов. Важно: карты
 * Blackmagic UltraStudio / DeckLink работают через свой драйвер Desktop Video и
 * в getUserMedia НЕ появляются; ATEM Mini и Web Presenter — появляются.
 *
 * Источник живёт в состоянии как обычный «файл» с псевдо-путём
 * `live://device?v=<метка камеры>&a=<метка звука>`. Так плейлист, превью, TAKE,
 * персист в electron-store и .pdpres работают без единой правки — весь конвейер
 * уже умеет «path + kind».
 *
 * Устройство запоминается по МЕТКЕ, а не по deviceId: id живёт до перезапуска
 * приложения и меняется при перевтыкании, метка («AVMatrix USB Capture») —
 * стабильна. Резолв метка→id делает рендерер в момент открытия потока.
 */

import { DEFAULT_LIVE_FIT } from './types.js'
import type { LiveFit, PlaylistEntry } from './types.js'
import { t } from './i18n.js'
import { validOmtAddress } from './omt-input.js'

export const LIVE_SCHEME = 'live'

const LIVE_PREFIX = `${LIVE_SCHEME}://device`

export interface WindowCrop { unit?: 'px'; top: number; right: number; bottom: number; left: number }
export function normalizeWindowCrop(crop?: Partial<WindowCrop>): WindowCrop {
  const pixels = crop?.unit === 'px'
  const edge = (v: unknown): number => typeof v === 'number' && Number.isFinite(v)
    ? pixels ? Math.max(0, Math.round(v)) : Math.max(0, Math.min(45, v)) : 0
  return { ...(pixels ? { unit: 'px' as const } : {}), top: edge(crop?.top), right: edge(crop?.right), bottom: edge(crop?.bottom), left: edge(crop?.left) }
}

/** Clamp in the source's pixels, always retaining at least one pixel per axis. */
export function windowCropRect(width: number, height: number, crop?: Partial<WindowCrop>): { x: number; y: number; width: number; height: number } {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const c = normalizeWindowCrop(crop)
  const px = (value: number, size: number) => Math.round(c.unit === 'px' ? value : size * value / 100)
  const x = Math.min(w - 1, px(c.left, w)), y = Math.min(h - 1, px(c.top, h))
  const right = Math.min(w - x - 1, px(c.right, w)), bottom = Math.min(h - y - 1, px(c.bottom, h))
  return { x, y, width: w - x - right, height: h - y - bottom }
}

export interface LiveSource {
  kind?: 'window' | 'omt'
  omtAddress?: string
  windowId?: string
  windowCrop?: WindowCrop
  windowFps?: number
  /** MediaDeviceInfo.label видеовхода. */
  videoLabel: string
  /** MediaDeviceInfo.label аудиовхода; null — звук с этого источника не берём. */
  audioLabel: string | null
}

export function isLiveUri(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(`${LIVE_SCHEME}://`)
}

export function makeLiveUri(src: LiveSource): string {
  const q = new URLSearchParams()
  q.set('v', src.videoLabel)
  if (src.kind === 'omt') {
    if (!validOmtAddress(src.omtAddress)) throw new Error(t('Адрес OMT задан неверно'))
    q.set('address', src.omtAddress)
    q.set('audio', src.audioLabel ? '1' : '0')
    return `live://omt?${q.toString()}`
  }
  if (src.kind !== 'window' && src.audioLabel) q.set('a', src.audioLabel)
  if (src.kind === 'window') {
    if (src.windowId) q.set('id', src.windowId)
    if (src.windowFps !== undefined) q.set('fps', String(normalizeWindowFps(src.windowFps)))
    const crop = normalizeWindowCrop(src.windowCrop)
    if (crop.unit === 'px') q.set('cropUnit', 'px')
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) if (crop[edge]) q.set(edge, String(crop[edge]))
    return `live://window?${q.toString()}`
  }
  return `${LIVE_PREFIX}?${q.toString()}`
}

/** Разбирает псевдо-путь обратно в источник; null — путь не живой/битый. */
export function parseLiveUri(path: string | null | undefined): LiveSource | null {
  if (!isLiveUri(path)) return null
  const prefix = (path as string).split('?')[0]
  if (prefix !== LIVE_PREFIX && prefix !== 'live://window' && prefix !== 'live://omt') return null
  const qs = (path as string).slice((path as string).indexOf('?') + 1)
  if (!qs || qs === path) return null
  const q = new URLSearchParams(qs)
  const videoLabel = q.get('v')
  if (!videoLabel) return null
  if (prefix === 'live://omt') {
    const omtAddress = q.get('address')
    if (!validOmtAddress(omtAddress)) return null
    return { kind: 'omt', omtAddress, videoLabel, audioLabel: q.get('audio') === '0' ? null : videoLabel }
  }
  if (prefix === 'live://window') {
    const crop = normalizeWindowCrop({ ...(q.get('cropUnit') === 'px' ? { unit: 'px' as const } : {}), top: Number(q.get('top')), right: Number(q.get('right')), bottom: Number(q.get('bottom')), left: Number(q.get('left')) })
    return { kind: 'window', windowId: q.get('id') || undefined, videoLabel, audioLabel: null,
      ...(q.has('fps') ? { windowFps: normalizeWindowFps(Number(q.get('fps'))) } : {}),
      ...([crop.top, crop.right, crop.bottom, crop.left].some(Boolean) ? { windowCrop: crop } : {}) }
  }
  return { videoLabel, audioLabel: q.get('a') || null }
}

/** Имя источника для плейлиста и заголовков. */
export function liveDisplayName(path: string): string {
  return parseLiveUri(path)?.videoLabel ?? t('Внешний вход')
}

/**
 * Режим вписывания для деска: ищем запись плейлиста, из которой он загружен.
 * Сначала по id (надёжнее — путь мог смениться правкой устройств), потом по
 * пути (деск мог пережить очистку currentPlaylistId). Не нашли — дефолт.
 */
export function liveFitFor(
  playlist: readonly Pick<PlaylistEntry, 'id' | 'filePath' | 'liveFit'>[],
  playlistId: string | null,
  path: string | null,
): LiveFit {
  if (!path) return DEFAULT_LIVE_FIT
  const byId = playlistId ? playlist.find((e) => e.id === playlistId) : undefined
  const entry = byId?.filePath === path ? byId : playlist.find((e) => e.filePath === path)
  return entry?.liveFit ?? DEFAULT_LIVE_FIT
}

export function normalizeWindowFps(fps?: number): number {
  return typeof fps === "number" && Number.isFinite(fps) ? Math.max(1, Math.min(60, Math.floor(fps))) : 30
}
