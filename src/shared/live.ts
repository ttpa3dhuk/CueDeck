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

export const LIVE_SCHEME = 'live'

const LIVE_PREFIX = `${LIVE_SCHEME}://device`

export interface LiveSource {
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
  if (src.audioLabel) q.set('a', src.audioLabel)
  return `${LIVE_PREFIX}?${q.toString()}`
}

/** Разбирает псевдо-путь обратно в источник; null — путь не живой/битый. */
export function parseLiveUri(path: string | null | undefined): LiveSource | null {
  if (!isLiveUri(path)) return null
  const qs = (path as string).slice((path as string).indexOf('?') + 1)
  if (!qs || qs === path) return null
  const q = new URLSearchParams(qs)
  const videoLabel = q.get('v')
  if (!videoLabel) return null
  return { videoLabel, audioLabel: q.get('a') || null }
}

/** Имя источника для плейлиста и заголовков. */
export function liveDisplayName(path: string): string {
  return parseLiveUri(path)?.videoLabel ?? 'Внешний вход'
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
