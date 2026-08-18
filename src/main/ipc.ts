import { dialog, globalShortcut, ipcMain, screen } from 'electron'
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type { DisplayMap, Layout } from './layout.js'
import type {
  DeckState,
  FileKind,
  ListItem,
  ListMode,
  LiveFit,
  PlaylistEntry,
  SlideMedia,
  TimerMode,
  TimerPosition,
  VideoTakeMode,
} from './state.js'
import { store, initialDeckState, DEFAULT_SPEAKER_MSG_PRESETS, DEFAULT_TIMER_PRESETS } from './state.js'
import { DEFAULT_LIVE_FIT } from '../shared/types.js'
import { isLiveUri, liveDisplayName, makeLiveUri, parseLiveUri } from '../shared/live.js'
import type { LiveSource } from '../shared/live.js'
import { computePdfSha1, computeStatSha1, loadNotes, notesWriter, sha1FromBuffer, sidecarPathFor } from './notes-store.js'
import { applyLayout, getOperatorWindow } from './windows.js'
import {
  saveMapping,
  getLastPdfPath,
  getPlaylist,
  getCurrentPlaylistId,
  getKeyVisualPath,
  getProjectPath,
  setLastPdfPath,
  setLastDurationMs,
  setTimerMode,
  setTimerPosition,
  setTimerScale,
  setVideoTakeMode,
  setSlideTakeMode,
  setNotesFontSize,
  setPlaylist,
  setCurrentPlaylistId,
  setKeyVisualPath,
  setProjectPath,
  setPlaylistCompact,
  setAutoAdvance,
  setAudienceWindowed,
  setAudioOutputId,
  setPreviewAudioOutputId,
  setTimerTickEnabled,
  setTimerGongEnabled,
  setTimerLoop,
  getAskLayoutOnStartup,
  setAskLayoutOnStartup,
  setClickerGlobal,
  getClickerGlobalArrows,
  setClickerGlobalArrows,
  setSpeakerMsgPresets,
  setTimerPresets,
  setOutputMonitorsEnabled,
  setUiTheme,
} from './display-mapping.js'
import { indexFolder, pickBestCandidate, uniqueName } from './project-files.js'
import { countPdfPages } from './pdf-pages.js'
import { cachedPdfPathFor, convertPptxToPdf, findSoffice, recheckSoffice, setManualSoffice, sofficeSearchPaths } from './pptx-converter.js'
import { preparePptxMedia } from './pptx-media.js'
import {
  loadProjectFile,
  PROJECT_EXTENSION,
  saveProjectFile,
} from './project.js'

import type { DisplayInfo, OpenPdfResult } from '../shared/types.js'

export type { DisplayInfo, OpenPdfResult } from '../shared/types.js'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const PDF_EXTS = new Set(['pdf'])
const PPTX_EXTS = new Set(['pptx', 'ppt', 'odp', 'key'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm'])

const ALL_SUPPORTED_EXTS = [
  ...PDF_EXTS,
  ...PPTX_EXTS,
  ...IMAGE_EXTS,
  ...VIDEO_EXTS,
]

const VIDEO_EXTS_ARR = [...VIDEO_EXTS]
const IMAGE_EXTS_ARR = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

const OPEN_DIALOG_FILTERS: Electron.FileFilter[] = [
  { name: 'Все поддерживаемые', extensions: ALL_SUPPORTED_EXTS },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'PowerPoint / Keynote', extensions: ['pptx', 'ppt', 'odp', 'key'] },
  { name: 'Видео', extensions: VIDEO_EXTS_ARR },
  { name: 'Изображения', extensions: IMAGE_EXTS_ARR },
]

function extOf(path: string): string {
  return path.toLowerCase().split('.').pop() ?? ''
}

export function kindOf(path: string): FileKind | null {
  // Живой вход опознаём до расширений — у него псевдо-путь, а не файл.
  if (isLiveUri(path)) return 'live'
  const ext = extOf(path)
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (PPTX_EXTS.has(ext)) return 'pptx'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return null
}

export function mimeOf(path: string): string {
  const ext = extOf(path)
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
  }
  return map[ext] ?? 'application/octet-stream'
}

interface InspectedFile {
  kind: FileKind
  sha1: string
  totalSlides: number
  notes: Record<number, string>
  sha1Mismatch: boolean
  slideMedia: SlideMedia[]
}

/** Read a file's identity + page count + sidecar notes. Shared by both decks. */
async function inspectFile(filePath: string): Promise<InspectedFile> {
  const kind = kindOf(filePath)
  if (!kind) throw new Error('Неподдерживаемый формат файла')

  // Живой вход: файла нет — ни читать, ни считать страницы, ни искать заметки.
  // Идентичность = сам псевдо-путь (сменил устройство → сменился «файл»).
  if (kind === 'live') {
    if (!parseLiveUri(filePath)) throw new Error('Неверно задан внешний вход')
    return { kind, sha1: filePath, totalSlides: 1, notes: {}, sha1Mismatch: false, slideMedia: [] }
  }

  let sha1: string
  let totalSlides = 1
  let slideMedia: SlideMedia[] = []

  if (kind === 'pdf') {
    // Single read: compute SHA1 and count pages from the same buffer.
    const buf = await readFile(filePath)
    sha1 = sha1FromBuffer(buf)
    totalSlides = countPdfPages(buf)
  } else if (kind === 'pptx') {
    sha1 = await computePdfSha1(filePath)
    // Вшитые видео (2.10): извлечь ролики + manifest, LibreOffice получает
    // копию без видеофайлов — иначе он зашивает mp4 внутрь PDF целиком.
    const prepared = await preparePptxMedia(filePath, sha1)
    slideMedia = prepared.slideMedia
    try {
      const cachedPath = await convertPptxToPdf(prepared.convertSource, sha1)
      const buf = await readFile(cachedPath)
      totalSlides = countPdfPages(buf)
    } finally {
      if (prepared.temporary) rm(prepared.convertSource, { force: true }).catch(() => undefined)
    }
  } else if (kind === 'video') {
    // video: don't read the whole (possibly multi-GB) file — id from stat only
    sha1 = await computeStatSha1(filePath)
  } else {
    // image: totalSlides stays 1, just need SHA1
    sha1 = await computePdfSha1(filePath)
  }

  const loaded = await loadNotes(filePath, sha1)
  return { kind, sha1, totalSlides, notes: loaded.notes, sha1Mismatch: loaded.sha1Mismatch, slideMedia }
}

/**
 * ── Проигрыватель списка (kind='list') ──────────────────────────────────
 * Список — пачка фото и роликов, которую крутят на сборе гостей или в
 * перерыве. Реализован как сценарий поверх обычной загрузки файла: main по
 * очереди открывает элементы в эфирный деск, а рендереры показывают их как
 * любой другой файл — своей логики показа у списка нет вообще.
 *
 * Кто двигает очередь: фотографию — таймер здесь, ролик — событие `ended` от
 * окна оператора (тот же авторитет, что и у одиночных роликов).
 */
let listTimer: NodeJS.Timeout | null = null
let activeListId: string | null = null
/** Порядок обхода: для 'shuffle' это перетасованные индексы, иначе 0..n-1. */
let listOrder: number[] = []

function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i)
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function buildListOrder(entry: PlaylistEntry): number[] {
  const n = entry.items?.length ?? 0
  return listModeOf(entry) === 'shuffle' ? shuffled(n) : Array.from({ length: n }, (_, i) => i)
}

/** Старый флаг `loop` = 'loop', его отсутствие у списка = один проход. */
function listModeOf(entry: PlaylistEntry): ListMode {
  return entry.listMode ?? (entry.loop ? 'loop' : 'once')
}

function clearListTimer(): void {
  if (listTimer) clearTimeout(listTimer)
  listTimer = null
}

/** Снять список с эфира: оператор выдал что-то другое, очистил проект и т.п. */
export function stopListPlayback(): void {
  clearListTimer()
  if (activeListId === null) return
  activeListId = null
  listOrder = []
  store.patch({ listIndex: -1, listPos: -1 })
}

const DEFAULT_PHOTO_SEC = 8

function listEntryById(id: string | null): PlaylistEntry | undefined {
  if (!id) return undefined
  const e = store.get().playlist.find((x) => x.id === id)
  return e?.kind === 'list' ? e : undefined
}

/** Показать элемент списка с индексом index; при выходе за край — цикл или стоп. */
async function playListItem(entryId: string, pos: number): Promise<void> {
  const entry = listEntryById(entryId)
  const items = entry?.items ?? []
  if (!entry || items.length === 0) {
    stopListPlayback()
    return
  }
  clearListTimer()
  if (listOrder.length !== items.length || activeListId !== entryId) {
    listOrder = buildListOrder(entry)
  }

  const mode = listModeOf(entry)
  if (pos >= items.length || pos < 0) {
    // Дошли до края: 'once' встаёт на последнем элементе (гасить зал по концу
    // пачки — сюрприз для зала), остальные режимы идут по новой. Вперемешку
    // на каждом проходе тасуется заново, иначе «случайный» порядок повторяется.
    if (mode === 'once') {
      activeListId = null
      return
    }
    listOrder = buildListOrder(entry)
    pos = pos < 0 ? items.length - 1 : 0
  }

  activeListId = entryId
  const index = listOrder[pos] ?? pos
  const item = items[index]
  store.patch({ listIndex: index, listPos: pos })
  const res = await openFile(item.path, { playlistId: entryId, fromList: true })
  if (!res.ok) {
    // Битый или пропавший файл не должен вешать всю пачку — идём дальше.
    if (items.length > 1) scheduleListAdvance(entry, 0.5)
    return
  }
  if (item.kind === 'video') {
    // Ролик в списке стартует сам: пауза посреди перерыва никому не нужна.
    store.patchVideo({ playing: true, anchorSec: 0, anchorAt: Date.now() })
  } else {
    scheduleListAdvance(entry, entry.photoSec || DEFAULT_PHOTO_SEC)
  }
}

function scheduleListAdvance(entry: PlaylistEntry, sec: number): void {
  clearListTimer()
  const id = entry.id
  listTimer = setTimeout(() => {
    void playListItem(id, store.get().listPos + 1)
  }, Math.max(0.2, sec) * 1000)
}

/** Стартовать список с начала (выдача в эфир). */
export async function startListPlayback(entryId: string): Promise<void> {
  await playListItem(entryId, 0)
}

/** Шаг по списку кликером/клавишами; direction = ±1. */
export async function stepList(direction: number): Promise<void> {
  if (!activeListId) return
  await playListItem(activeListId, store.get().listPos + direction)
}

export function isListPlaying(): boolean {
  return activeListId !== null
}

/** Load a file straight to the PROGRAM (audience) feed. */
/**
 * Человеческий текст вместо «ENOENT: no such file or directory». Узнать про
 * переехавший материал в момент выдачи в зал — само по себе плохо, но хотя бы
 * понятно, что случилось и куда нажимать. Заодно пересчитываем метки в
 * плейлисте: раз файла нет — запись должна покраснеть.
 */
function openErrorMessage(err: unknown, filePath: string): string {
  const e = err as NodeJS.ErrnoException
  if (e?.code !== 'ENOENT') return (err as Error).message
  void refreshMissingFiles()
  return `Файл не найден: ${basename(filePath)} — материал переехал. Нажми «Указать файл…» на карточке`
}

async function openFile(
  filePath: string,
  opts: { playlistId?: string | null; durationMs?: number; fromList?: boolean } = {},
): Promise<OpenPdfResult> {
  // Любая загрузка в эфир мимо проигрывателя снимает список с эфира — иначе
  // его таймер продолжил бы подменять картинку под уже другим материалом.
  if (!opts.fromList) stopListPlayback()
  try {
    const info = await inspectFile(filePath)
    const playlistId = opts.playlistId ?? null
    const timerPatch: Partial<import('./state.js').TimerState> = {
      startedAt: null,
      elapsedMs: 0,
      running: false,
      cycles: 0,
    }
    if (typeof opts.durationMs === 'number') timerPatch.durationMs = opts.durationMs

    // Цикл — свойство записи плейлиста: заряжаем эфир её настройкой. Файл,
    // открытый мимо плейлиста, всегда стартует без цикла.
    const entry = playlistId ? store.get().playlist.find((e) => e.id === playlistId) : undefined

    store.patch({
      // У списка `loop` — про всю пачку, а не про отдельный ролик внутри неё:
      // элемент доигрывает и уступает место следующему.
      videoLoop: Boolean(entry?.loop) && entry?.kind !== 'list',
      pdfPath: filePath,
      pdfSha1: info.sha1,
      fileKind: info.kind,
      totalSlides: info.totalSlides,
      currentSlide: 1,
      notes: info.notes,
      slideMedia: info.slideMedia,
      currentPlaylistId: playlistId,
      // Reset the playback clock for every file load; keep audience-mute preference.
      video: {
        playing: false,
        anchorSec: 0,
        anchorAt: null,
        durationSec: 0,
        muted: store.get().video.muted,
      },
    })
    store.patchTimer(timerPatch)

    setLastPdfPath(filePath)
    setCurrentPlaylistId(playlistId)
    if (typeof opts.durationMs === 'number') setLastDurationMs(opts.durationMs)

    return {
      ok: true,
      path: filePath,
      totalSlides: info.totalSlides,
      sha1: info.sha1,
      sha1Mismatch: info.sha1Mismatch,
      kind: info.kind,
    }
  } catch (err) {
    return { ok: false, error: openErrorMessage(err, filePath) }
  }
}

/** Load a file into the off-air PREVIEW deck (does not touch the audience feed). */
async function loadPreview(
  filePath: string,
  opts: { playlistId?: string | null } = {},
): Promise<OpenPdfResult> {
  try {
    const info = await inspectFile(filePath)
    store.patchPreview({
      path: filePath,
      sha1: info.sha1,
      kind: info.kind,
      totalSlides: info.totalSlides,
      currentSlide: 1,
      notes: info.notes,
      playlistId: opts.playlistId ?? null,
      slideMedia: info.slideMedia,
      video: { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: true },
    })
    return {
      ok: true,
      path: filePath,
      totalSlides: info.totalSlides,
      sha1: info.sha1,
      sha1Mismatch: info.sha1Mismatch,
      kind: info.kind,
    }
  } catch (err) {
    return { ok: false, error: openErrorMessage(err, filePath) }
  }
}

/**
 * Слайд-видео (2.10): уход со слайда/приход на слайд всегда начинает с
 * остановленного ролика на нулевой позиции. durationSec обнуляем — авторитет
 * по длительности нового ролика — loadedmetadata у оператора.
 */
function resetProgramVideoOnSlideChange(): void {
  const s = store.get()
  if (s.fileKind === 'pptx' && s.slideMedia.length > 0) {
    store.patchVideo({ playing: false, anchorSec: 0, anchorAt: null, durationSec: 0 })
  }
}

function resetPreviewVideoOnSlideChange(): void {
  const p = store.get().preview
  if (p.kind === 'pptx' && p.slideMedia.length > 0) {
    store.patchPreviewVideo({ playing: false, anchorSec: 0, anchorAt: null, durationSec: 0 })
  }
}

async function programNext(): Promise<void> {
  // Список в эфире: «далее» переключает элемент пачки, а не листает файл.
  if (isListPlaying()) {
    await stepList(1)
    return
  }
  const state = store.get()
  const { currentSlide, totalSlides, autoAdvance, playlist, currentPlaylistId } = state

  // Механика живых шоу (спикер с кликером, DSan MicroCue и т.п.): на слайде
  // с видео первый «далее» запускает ролик — спикер договорил подводку и сам
  // стартует видео тем же кликером. Следующий «далее» листает дальше. Ролик,
  // который уже играл (позиция > 0 или доигран), клик не перезапускает.
  if (state.fileKind === 'pptx' && !state.video.playing && state.video.anchorSec === 0) {
    const m = state.slideMedia.find((mm) => mm.slide === currentSlide)
    if (m) {
      store.patchVideo({ playing: true, anchorSec: 0, anchorAt: Date.now() })
      return
    }
  }

  // Файл-видео в эфире (Б-2): та же механика, что и у слайд-видео выше —
  // неигравший ролик (позиция 0, после автоперехода плейлиста) первый клик
  // «далее» запускает; играющий/отмотанный — прежняя перемотка +5с кликера.
  if (state.fileKind === 'video') {
    if (!state.video.playing && store.videoPositionSec() < 0.5) {
      store.patchVideo({ playing: true, anchorAt: Date.now() })
    } else {
      programSeekBy(5)
    }
    return
  }

  // Живой вход: листать и перематывать нечего. Молчим намеренно — иначе
  // случайный клик спикера увёл бы эфир на следующего по autoAdvance.
  if (state.fileKind === 'live') return

  if (currentSlide < totalSlides) {
    store.patch({ currentSlide: currentSlide + 1 })
    resetProgramVideoOnSlideChange()
    return
  }
  if (!autoAdvance || !currentPlaylistId || playlist.length === 0) return
  const idx = playlist.findIndex((e) => e.id === currentPlaylistId)
  if (idx < 0 || idx >= playlist.length - 1) return
  const next = playlist[idx + 1]
  await openFile(next.filePath, { playlistId: next.id, durationMs: next.durationMs })
}

function programPrev(): void {
  if (isListPlaying()) {
    void stepList(-1)
    return
  }
  const state = store.get()
  if (state.fileKind === 'live') return
  if (state.fileKind === 'video') {
    programSeekBy(-5)
    return
  }
  if (state.currentSlide > 1) {
    store.patch({ currentSlide: state.currentSlide - 1 })
    resetProgramVideoOnSlideChange()
  }
}

function programSeekBy(deltaSec: number): void {
  const v = store.get().video
  const delta = Number.isFinite(deltaSec) ? deltaSec : 0
  let pos = Math.max(0, store.videoPositionSec() + delta)
  if (v.durationSec > 0) pos = Math.min(pos, v.durationSec)
  store.patchVideo({ anchorSec: pos, anchorAt: v.playing ? Date.now() : null })
}

/**
 * Global clicker via globalShortcut: the speaker keeps flipping the program
 * deck while the operator works in another app (browser, Finder — e.g.
 * downloading the next presentation mid-show). Mirrors the renderer's clicker
 * behaviour: video seeks ±5s, everything else changes slides. Blank (.) and
 * Take stay window-local on purpose — grabbing "." system-wide would eat the
 * dot everywhere the operator types.
 *
 * Two key sets: PgUp/PgDn (R400, DSan и т.п.) always; ←/→ arrows as a separate
 * opt-in for clickers that send arrows (Logitech Spotlight) — stealing arrows
 * system-wide hurts much more, so it's the user's explicit call.
 *
 * Returns what actually got enabled: registration fails if another app holds
 * a key; a failed pair is fully released so we never end up half-on.
 */
export function applyClickerShortcuts(
  global: boolean,
  arrows: boolean,
): { global: boolean; arrows: boolean } {
  for (const key of ['PageDown', 'PageUp', 'Right', 'Left']) globalShortcut.unregister(key)
  if (!global) return { global: false, arrows: false }

  // Видео-логику (свежий ролик → play, играющий → ±5с) решает сам
  // programNext/programPrev — единая точка для кликера, клавиш и кнопок.
  const forward = (): void => void programNext()
  const back = (): void => programPrev()

  const okPages = globalShortcut.register('PageDown', forward) && globalShortcut.register('PageUp', back)
  if (!okPages) {
    globalShortcut.unregister('PageDown')
    globalShortcut.unregister('PageUp')
    return { global: false, arrows: false }
  }

  let okArrows = false
  if (arrows) {
    okArrows = globalShortcut.register('Right', forward) && globalShortcut.register('Left', back)
    if (!okArrows) {
      globalShortcut.unregister('Right')
      globalShortcut.unregister('Left')
    }
  }
  return { global: true, arrows: okArrows }
}

function persistPlaylist(): void {
  setPlaylist(store.get().playlist)
}

/**
 * Проверка материалов плейлиста на диске. Живые входы пропускаем — это не
 * файлы. Проверка идёт параллельно и не блокирует открытие проекта: на сетевой
 * шаре `access` может подтормаживать.
 * Возвращает число ненайденных, чтобы вызывающий показал баннер.
 */
export async function refreshMissingFiles(): Promise<number> {
  const playlist = store.get().playlist
  const checks = await Promise.all(
    playlist.map(async (e) => {
      if (e.kind === 'live' || isLiveUri(e.filePath)) return null
      // Список помечаем пропавшим, если нет хотя бы одного его материала:
      // дыра в пачке на сборе гостей так же заметна, как пропавший доклад.
      const paths = e.kind === 'list' ? (e.items ?? []).map((i) => i.path) : [e.filePath]
      if (paths.length === 0) return null
      for (const path of paths) {
        try {
          await access(path)
        } catch {
          return e.id
        }
      }
      return null
    }),
  )
  const missingIds = checks.filter((id): id is string => id !== null)
  const before = store.get().missingIds
  // Патчим только при изменении — плейлист перерисовывается на каждый патч.
  if (before.length !== missingIds.length || missingIds.some((id, i) => before[i] !== id)) {
    store.patch({ missingIds })
  }
  return missingIds.length
}

/**
 * Сохранение проекта (.pdpres). Вынесено из ipc-хендлера, потому что этим же
 * путём ходит кнопка «Сохранить и закрыть» в подтверждении выхода
 * (quit-guard.ts). `ok: false` без `error` = пользователь отменил выбор файла —
 * в этом случае приложение закрывать нельзя.
 */
export async function saveProject(
  saveAs = false,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const op = getOperatorWindow()
  const state = store.get()
  let target = state.projectPath
  if (!target || saveAs) {
    const res = await dialog.showSaveDialog(op!, {
      title: 'Сохранить проект',
      defaultPath: target ?? `presenter-project.${PROJECT_EXTENSION}`,
      filters: [{ name: 'CueDeck project', extensions: [PROJECT_EXTENSION] }],
    })
    if (res.canceled || !res.filePath) return { ok: false }
    target = res.filePath
  }
  try {
    await saveProjectFile(target, {
      playlist: state.playlist,
      keyVisualPath: state.keyVisualPath,
    })
    store.patch({ projectPath: target })
    setProjectPath(target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('pdf:open-dialog', async () => {
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: 'Открыть PDF, PPTX, видео или изображение',
      filters: OPEN_DIALOG_FILTERS,
      properties: ['openFile'],
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, cancelled: true }
    return openFile(res.filePaths[0])
  })

  ipcMain.handle('pdf:open-path', async (_e, filePath: string) => {
    return openFile(filePath)
  })

  ipcMain.handle('pdf:read', async (): Promise<{ bytes: Uint8Array; mime: string } | null> => {
    const { pdfPath, fileKind, pdfSha1 } = store.get()
    if (!pdfPath || fileKind === 'live') return null
    try {
      // For PPTX, read the cached converted PDF instead of the source file
      const readPath =
        fileKind === 'pptx' && pdfSha1 ? cachedPdfPathFor(pdfSha1) : pdfPath
      const buf = await readFile(readPath)
      const mime = fileKind === 'pptx' ? 'application/pdf' : mimeOf(pdfPath)
      return {
        bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        mime,
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('pdf:report-total', (_e, total: number) => {
    if (typeof total === 'number' && total > 0 && total !== store.get().totalSlides) {
      store.patch({ totalSlides: total })
    }
  })

  ipcMain.handle('nav:goto', (_e, slide: number) => {
    const { totalSlides, currentSlide } = store.get()
    if (totalSlides === 0) return
    const clamped = Math.max(1, Math.min(totalSlides, slide))
    if (clamped === currentSlide) return
    store.patch({ currentSlide: clamped })
    resetProgramVideoOnSlideChange()
  })

  ipcMain.handle('nav:next', () => programNext())

  ipcMain.handle('nav:prev', () => programPrev())

  ipcMain.handle('clicker:set-global', (_e, value: boolean) => {
    const wantArrows = getClickerGlobalArrows()
    const res = applyClickerShortcuts(Boolean(value), wantArrows)
    store.patch({ clickerGlobal: res.global })
    setClickerGlobal(res.global)
    if (res.global && wantArrows && !res.arrows) {
      store.patch({ clickerGlobalArrows: false })
      setClickerGlobalArrows(false)
    }
    return res.global
  })

  ipcMain.handle('clicker:set-global-arrows', (_e, value: boolean) => {
    const v = Boolean(value)
    // Global mode off — just remember the intent, keys get grabbed when it turns on.
    if (!store.get().clickerGlobal) {
      store.patch({ clickerGlobalArrows: v })
      setClickerGlobalArrows(v)
      return v
    }
    const res = applyClickerShortcuts(true, v)
    store.patch({ clickerGlobal: res.global, clickerGlobalArrows: res.arrows })
    setClickerGlobal(res.global)
    setClickerGlobalArrows(res.arrows)
    return res.arrows
  })

  // ── Preview deck (off-air staging) ───────────────────────────────────────
  // Operator-only. Loading here never touches the audience feed; `preview:take`
  // promotes the staged deck to program.

  ipcMain.handle('preview:open-dialog', async () => {
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: 'Открыть в превью',
      filters: OPEN_DIALOG_FILTERS,
      properties: ['openFile'],
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, cancelled: true }
    return loadPreview(res.filePaths[0])
  })

  ipcMain.handle('preview:open-path', async (_e, filePath: string) => {
    return loadPreview(filePath)
  })

  ipcMain.handle('preview:read', async (): Promise<{ bytes: Uint8Array; mime: string } | null> => {
    const { path, kind, sha1 } = store.get().preview
    if (!path || kind === 'live') return null
    try {
      const readPath = kind === 'pptx' && sha1 ? cachedPdfPathFor(sha1) : path
      const buf = await readFile(readPath)
      const mime = kind === 'pptx' ? 'application/pdf' : mimeOf(path)
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mime }
    } catch {
      return null
    }
  })

  ipcMain.handle('preview:report-total', (_e, total: number) => {
    const p = store.get().preview
    if (typeof total === 'number' && total > 0 && total !== p.totalSlides) {
      store.patchPreview({ totalSlides: total })
    }
  })

  ipcMain.handle('preview:goto', (_e, slide: number) => {
    const { totalSlides, currentSlide } = store.get().preview
    if (totalSlides === 0) return
    const clamped = Math.max(1, Math.min(totalSlides, slide))
    if (clamped === currentSlide) return
    store.patchPreview({ currentSlide: clamped })
    resetPreviewVideoOnSlideChange()
  })

  /** Пролистать пачку в превью; direction = ±1. Возвращает false, если превью не список. */
  async function stepPreviewList(direction: number): Promise<boolean> {
    const state = store.get()
    const entry = state.preview.playlistId
      ? state.playlist.find((e) => e.id === state.preview.playlistId && e.kind === 'list')
      : undefined
    const items = entry?.items ?? []
    if (!entry || items.length === 0) return false
    const cur = state.previewListIndex < 0 ? 0 : state.previewListIndex
    // По краям заворачиваем всегда: в превью это просто просмотр пачки.
    const next = (((cur + direction) % items.length) + items.length) % items.length
    store.patch({ previewListIndex: next })
    await loadPreview(items[next].path, { playlistId: entry.id })
    return true
  }

  ipcMain.handle('preview:next', async () => {
    if (await stepPreviewList(1)) return
    const { currentSlide, totalSlides } = store.get().preview
    if (currentSlide < totalSlides) {
      store.patchPreview({ currentSlide: currentSlide + 1 })
      resetPreviewVideoOnSlideChange()
    }
  })

  ipcMain.handle('preview:prev', async () => {
    if (await stepPreviewList(-1)) return
    const { currentSlide } = store.get().preview
    if (currentSlide > 1) {
      store.patchPreview({ currentSlide: currentSlide - 1 })
      resetPreviewVideoOnSlideChange()
    }
  })

  ipcMain.handle('preview:clear', () => {
    store.patch({ preview: initialDeckState() })
  })

  // Promote the staged preview deck onto the audience feed. Taking a playlist
  // entry applies its per-speaker timer (duration + reset, NOT started — the
  // operator starts it manually); taking a loose file leaves the timer alone.
  // Video behaviour on take follows AppState.videoTakeMode.
  ipcMain.handle('preview:take', () => {
    const state = store.get()
    const p = state.preview
    if (!p.path) return

    // В превью лежит первый элемент списка — в эфир уходит весь список,
    // с его циклом и таймингом фотографий.
    const previewList = p.playlistId
      ? state.playlist.find((e) => e.id === p.playlistId && e.kind === 'list')
      : undefined
    if (previewList) {
      store.patch({ previewListIndex: -1 })
      store.patchPreview(initialDeckState())
      void startListPlayback(previewList.id)
      store.patchTimer({
        durationMs: previewList.durationMs,
        startedAt: null,
        elapsedMs: 0,
        running: false,
        cycles: 0,
      })
      return
    }

    // New program video: always autoplayed on take; mode only picks start point.
    // Слайд-видео в PPTX на эфир не автоплеится — оператор запускает вручную.
    let video: import('./state.js').VideoState
    if (p.kind === 'video') {
      const mode = state.videoTakeMode
      // «Стоп на первом кадре»: ролик уходит в эфир замороженным на нулевой
      // позиции — первый кадр работает заставкой, а запускает его кликер
      // спикера первым «далее» (та же механика, что у видео на слайде).
      const hold = mode === 'hold-first'
      const startSec = mode === 'play-resume' ? store.previewVideoPositionSec() : 0
      video = {
        playing: !hold,
        anchorSec: hold ? 0 : startSec,
        anchorAt: hold ? null : Date.now(),
        durationSec: p.video.durationSec,
        muted: state.video.muted,
      }
    } else {
      video = { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: state.video.muted }
    }

    // Swap: whatever was on air goes back into preview (frozen, muted) so repeated
    // takes ping-pong the two decks. If program was empty, preview becomes empty.
    const oldProgramPos = store.videoPositionSec()
    const newPreview: DeckState = {
      path: state.pdfPath,
      sha1: state.pdfSha1,
      kind: state.fileKind,
      totalSlides: state.totalSlides,
      currentSlide: state.currentSlide,
      notes: state.notes,
      playlistId: state.currentPlaylistId,
      slideMedia: state.slideMedia,
      video:
        state.fileKind === 'video'
          ? { playing: false, anchorSec: oldProgramPos, anchorAt: null, durationSec: state.video.durationSec, muted: true }
          : { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: true },
    }

    // Слайдовые деки (Б-3): по режиму — с первого слайда (дефолт, оператор мог
    // полистать превью и забыть вернуть) или с текущего слайда превью.
    const takeSlide =
      (p.kind === 'pdf' || p.kind === 'pptx') && state.slideTakeMode === 'from-start'
        ? 1
        : p.currentSlide

    store.patch({
      pdfPath: p.path,
      pdfSha1: p.sha1,
      fileKind: p.kind,
      totalSlides: p.totalSlides,
      currentSlide: takeSlide,
      notes: p.notes,
      currentPlaylistId: p.playlistId,
      slideMedia: p.slideMedia,
      video,
      // Цикл берём у выдаваемой записи: ролик-заставка должен уйти в эфир
      // зациклённым сразу, без второго действия оператора.
      videoLoop: Boolean(
        p.playlistId ? state.playlist.find((e) => e.id === p.playlistId)?.loop : false,
      ),
      preview: newPreview,
    })
    setLastPdfPath(p.path)
    setCurrentPlaylistId(p.playlistId)

    const entry = p.playlistId ? state.playlist.find((e) => e.id === p.playlistId) : undefined
    if (entry) {
      store.patchTimer({
        durationMs: entry.durationMs,
        startedAt: null,
        elapsedMs: 0,
        running: false,
        cycles: 0,
      })
      setLastDurationMs(entry.durationMs)
    }
  })

  ipcMain.handle('preview:set-video-take-mode', (_e, mode: VideoTakeMode) => {
    store.patch({ videoTakeMode: mode })
    setVideoTakeMode(mode)
  })

  ipcMain.handle('preview:set-slide-take-mode', (_e, mode: string) => {
    const v = mode === 'from-current' ? 'from-current' : 'from-start'
    store.patch({ slideTakeMode: v })
    setSlideTakeMode(v)
  })

  // Preview video transport — mirrors the program clock helpers on preview.video.
  // Preview audio is always muted (the operator monitors it silently).
  ipcMain.handle('preview:video:toggle', () => {
    const v = store.get().preview.video
    if (v.playing) {
      store.patchPreviewVideo({ playing: false, anchorSec: store.previewVideoPositionSec(), anchorAt: null })
    } else {
      store.patchPreviewVideo({ playing: true, anchorSec: store.previewVideoPositionSec(), anchorAt: Date.now() })
    }
  })

  ipcMain.handle('preview:video:seek', (_e, sec: number) => {
    const v = store.get().preview.video
    let pos = Number.isFinite(sec) ? Math.max(0, sec) : 0
    if (v.durationSec > 0) pos = Math.min(pos, v.durationSec)
    store.patchPreviewVideo({ anchorSec: pos, anchorAt: v.playing ? Date.now() : null })
  })

  ipcMain.handle('preview:video:seek-by', (_e, deltaSec: number) => {
    const v = store.get().preview.video
    const delta = Number.isFinite(deltaSec) ? deltaSec : 0
    let pos = Math.max(0, store.previewVideoPositionSec() + delta)
    if (v.durationSec > 0) pos = Math.min(pos, v.durationSec)
    store.patchPreviewVideo({ anchorSec: pos, anchorAt: v.playing ? Date.now() : null })
  })

  ipcMain.handle('preview:video:set-duration', (_e, sec: number) => {
    if (!Number.isFinite(sec) || sec <= 0) return
    if (store.get().preview.video.durationSec === sec) return
    store.patchPreviewVideo({ durationSec: sec })
  })

  ipcMain.handle('preview:video:ended', () => {
    const state = store.get()
    const v = state.preview.video
    // Превью показывает то же поведение, что будет в эфире: зациклённая запись
    // и в превью крутится по кругу — иначе значок включён, а ролик встал.
    const entry = state.preview.playlistId
      ? state.playlist.find((e) => e.id === state.preview.playlistId)
      : undefined
    if (entry?.loop) {
      store.patchPreviewVideo({ playing: true, anchorSec: 0, anchorAt: Date.now() })
      return
    }
    store.patchPreviewVideo({ playing: false, anchorSec: v.durationSec || v.anchorSec, anchorAt: null })
  })

  ipcMain.handle('note:update', (_e, payload: { slide: number; text: string }) => {
    const { slide, text } = payload
    store.patchNotes(slide, text)
    const { pdfPath, pdfSha1, notes } = store.get()
    if (pdfPath && pdfSha1) notesWriter.schedule(pdfPath, pdfSha1, notes)
  })

  ipcMain.handle('timer:start', () => {
    const t = store.get().timer
    if (t.running) return
    store.patchTimer({ startedAt: Date.now(), running: true })
  })

  ipcMain.handle('timer:pause', () => {
    const t = store.get().timer
    if (!t.running || t.startedAt === null) return
    const elapsedMs = t.elapsedMs + (Date.now() - t.startedAt)
    store.patchTimer({ startedAt: null, elapsedMs, running: false })
  })

  ipcMain.handle('timer:reset', () => {
    store.patchTimer({ startedAt: null, elapsedMs: 0, running: false, cycles: 0 })
  })

  ipcMain.handle('timer:set-duration', (_e, ms: number) => {
    const clamped = Math.max(0, Math.floor(ms))
    store.patchTimer({ durationMs: clamped })
    setLastDurationMs(clamped)
  })

  ipcMain.handle('timer:adjust', (_e, deltaMs: number) => {
    const t = store.get().timer
    const next = Math.max(0, t.durationMs + Math.floor(deltaMs))
    store.patchTimer({ durationMs: next })
    setLastDurationMs(next)
  })

  ipcMain.handle('timer:set-mode', (_e, mode: TimerMode) => {
    store.patch({ timerMode: mode })
    setTimerMode(mode)
  })

  ipcMain.handle('timer:set-position', (_e, pos: TimerPosition) => {
    store.patch({ timerPosition: pos })
    setTimerPosition(pos)
  })

  ipcMain.handle('timer:set-scale', (_e, scale: number) => {
    const clamped = Math.max(0.5, Math.min(2.5, Math.round(scale * 100) / 100))
    store.patch({ timerScale: clamped })
    setTimerScale(clamped)
  })

  ipcMain.handle('timer:set-tick-sound', (_e, enabled: boolean) => {
    const v = Boolean(enabled)
    store.patch({ timerTickEnabled: v })
    setTimerTickEnabled(v)
  })

  ipcMain.handle('timer:set-gong-sound', (_e, enabled: boolean) => {
    const v = Boolean(enabled)
    store.patch({ timerGongEnabled: v })
    setTimerGongEnabled(v)
  })

  ipcMain.handle('timer:set-loop', (_e, enabled: boolean) => {
    const v = Boolean(enabled)
    store.patch({ timerLoop: v })
    setTimerLoop(v)
  })

  // Minutes of the four preset buttons are user-editable (ПКМ по кнопке);
  // invalid/empty slots fall back to the defaults slot by slot.
  ipcMain.handle('timer:set-presets', (_e, presets: number[]) => {
    const arr = Array.isArray(presets) ? presets : []
    const clean = DEFAULT_TIMER_PRESETS.map((def, i) => {
      const v = Math.floor(Number(arr[i]))
      return Number.isFinite(v) && v >= 1 && v <= 999 ? v : def
    })
    store.patch({ timerPresets: clean })
    setTimerPresets(clean)
  })

  // Цикличный таймер: на нуле перезапускаем круг. cycles++ — сигнал рендерерам
  // (гонг/вспышка), даже если между их тиками ноль «проскочил». Только countdown
  // и только при ненулевой длительности (иначе бесконечный спин рестартов).
  setInterval(() => {
    const s = store.get()
    const t = s.timer
    if (!s.timerLoop || s.timerMode !== 'countdown' || !t.running || t.startedAt === null) return
    if (t.durationMs <= 0) return
    const elapsed = t.elapsedMs + (Date.now() - t.startedAt)
    if (elapsed >= t.durationMs) {
      store.patchTimer({ startedAt: Date.now(), elapsedMs: 0, cycles: t.cycles + 1 })
    }
  }, 250)

  ipcMain.handle('notes:set-font-size', (_e, px: number) => {
    const clamped = Math.max(10, Math.min(72, Math.round(px)))
    store.patch({ notesFontSize: clamped })
    setNotesFontSize(clamped)
  })

  ipcMain.handle('blackout:toggle', () => {
    store.patch({ blackout: !store.get().blackout })
  })

  // Flash message on the speaker monitor (confidence monitor classic:
  // «Заканчивай», «Ближе к микрофону»…). Blinks until cleared with null.
  ipcMain.handle('speaker-message:set', (_e, text: string | null) => {
    const msg = typeof text === 'string' ? text.trim() : ''
    store.patch({ speakerMessage: msg ? msg : null })
  })

  // Texts of the six preset buttons are user-editable (ПКМ по кнопке);
  // holes/empties fall back to the defaults slot by slot (слоты 4–6
  // по умолчанию пустые — очистка оставляет их свободными).
  ipcMain.handle('speaker-message:set-presets', (_e, presets: string[]) => {
    const arr = Array.isArray(presets) ? presets : []
    const clean = DEFAULT_SPEAKER_MSG_PRESETS.map((def, i) => {
      const v = typeof arr[i] === 'string' ? arr[i].trim().slice(0, 60) : ''
      return v || def
    })
    store.patch({ speakerMsgPresets: clean })
    setSpeakerMsgPresets(clean)
  })

  // ── Video playback clock ─────────────────────────────────────────────────
  // All windows derive currentTime from this logical clock; only the operator
  // issues mutations. See StateStore.videoPositionSec / VideoState.

  ipcMain.handle('video:play', () => {
    const v = store.get().video
    if (v.playing) return
    // re-anchor at the frozen position so playback resumes from where it paused
    store.patchVideo({ playing: true, anchorSec: store.videoPositionSec(), anchorAt: Date.now() })
  })

  ipcMain.handle('video:pause', () => {
    const v = store.get().video
    if (!v.playing) return
    store.patchVideo({ playing: false, anchorSec: store.videoPositionSec(), anchorAt: null })
  })

  ipcMain.handle('video:toggle', () => {
    const v = store.get().video
    if (v.playing) {
      store.patchVideo({ playing: false, anchorSec: store.videoPositionSec(), anchorAt: null })
    } else {
      store.patchVideo({ playing: true, anchorSec: store.videoPositionSec(), anchorAt: Date.now() })
    }
  })

  ipcMain.handle('video:seek', (_e, sec: number) => {
    const v = store.get().video
    let pos = Number.isFinite(sec) ? Math.max(0, sec) : 0
    if (v.durationSec > 0) pos = Math.min(pos, v.durationSec)
    store.patchVideo({ anchorSec: pos, anchorAt: v.playing ? Date.now() : null })
  })

  ipcMain.handle('video:seek-by', (_e, deltaSec: number) => programSeekBy(deltaSec))

  ipcMain.handle('video:set-duration', (_e, sec: number) => {
    if (!Number.isFinite(sec) || sec <= 0) return
    if (store.get().video.durationSec === sec) return
    store.patchVideo({ durationSec: sec })
  })

  // Fired by the operator window when its <video> reaches the end.
  ipcMain.handle('video:ended', () => {
    if (isListPlaying()) {
      void stepList(1)
      return
    }
    const v = store.get().video
    // Цикл: ролик-заставка крутится, пока спикер на сцене — вместо паузы на
    // последнем кадре перезапускаем часы с нуля, и все окна следуют за ними.
    if (store.get().videoLoop) {
      store.patchVideo({ playing: true, anchorSec: 0, anchorAt: Date.now() })
      return
    }
    store.patchVideo({ playing: false, anchorSec: v.durationSec || v.anchorSec, anchorAt: null })
  })

  ipcMain.handle('video:set-loop', (_e, enabled: boolean) => {
    const value = Boolean(enabled)
    const { currentPlaylistId } = store.get()
    store.patch({ videoLoop: value })
    // Источник истины — запись плейлиста: настройка переживает переключения
    // эфира, перезапуск и уезжает в .pdpres вместе с проектом.
    if (currentPlaylistId) {
      store.patch({
        playlist: store.get().playlist.map((e) =>
          e.id === currentPlaylistId ? { ...e, loop: value } : e,
        ),
      })
      persistPlaylist()
    }
    // Включили цикл на уже доигравшем ролике — стартуем его сразу, иначе
    // пришлось бы жать play руками, а это делается ради заставки в эфире.
    const v = store.get().video
    if (value && !v.playing && v.durationSec > 0 && v.anchorSec >= v.durationSec - 0.3) {
      store.patchVideo({ playing: true, anchorSec: 0, anchorAt: Date.now() })
    }
  })

  ipcMain.handle('video:set-muted', (_e, muted: boolean) => {
    store.patchVideo({ muted: Boolean(muted) })
  })

  ipcMain.handle('video:toggle-muted', () => {
    store.patchVideo({ muted: !store.get().video.muted })
  })

  ipcMain.handle('audio:set-output', (_e, deviceId: string | null) => {
    const id = deviceId ? String(deviceId) : null
    store.patch({ audioOutputId: id })
    setAudioOutputId(id)
  })

  /**
   * Предпрослушка (SOLO/PFL): выход под наушники оператора. null = выключена,
   * превью снова немое. Дефолта «системный выход» здесь намеренно нет — на
   * площадке он запросто окажется трактом зала.
   */
  ipcMain.handle('audio:set-preview-output', (_e, deviceId: string | null) => {
    const id = deviceId ? String(deviceId) : null
    store.patch({ previewAudioOutputId: id })
    setPreviewAudioOutputId(id)
  })

  ipcMain.handle('displays:list', (): DisplayInfo[] => {
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      // Имя модели монитора от ОС (как в системных настройках macOS);
      // пустое (старые ОС/кривой EDID) — фолбэк на нумерацию.
      label: d.label || `Display ${i + 1}${d.internal ? ' (internal)' : ''}`,
      internal: d.internal,
      bounds: d.bounds,
    }))
  })

  ipcMain.handle('layout:set', (_e, payload: { layout: Layout; displayMap: DisplayMap; audienceWindowed?: boolean }) => {
    const windowed = Boolean(payload.audienceWindowed)
    applyLayout(payload.layout, payload.displayMap, windowed)
    saveMapping(payload.layout, payload.displayMap)
    setAudienceWindowed(windowed)
  })

  ipcMain.handle('layout:get-ask-on-startup', () => getAskLayoutOnStartup())

  ipcMain.handle('layout:set-ask-on-startup', (_e, value: boolean) => {
    setAskLayoutOnStartup(Boolean(value))
  })

  // Мониторы выходов под эфиром (живые снимки окон суфлёра/зала)
  ipcMain.handle('monitor:set-enabled', (_e, enabled: boolean) => {
    const v = Boolean(enabled)
    store.patch({ outputMonitorsEnabled: v })
    setOutputMonitorsEnabled(v)
  })

  ipcMain.handle('ui:set-theme', (_e, theme: string) => {
    const v = theme === 'light' ? 'light' : 'dark'
    store.patch({ uiTheme: v })
    setUiTheme(v)
  })

  /** Append supported files to the playlist; unsupported paths are skipped. */
  function toListItems(paths: string[]): ListItem[] {
    const out: ListItem[] = []
    for (const p of paths) {
      const kind = kindOf(p)
      if (kind !== 'image' && kind !== 'video') continue
      out.push({ path: p, fileName: basename(p), kind })
    }
    return out
  }

  function listDisplayName(items: ListItem[]): string {
    const photos = items.filter((i) => i.kind === 'image').length
    const videos = items.length - photos
    const parts: string[] = []
    if (photos) parts.push(`${photos} фото`)
    if (videos) parts.push(`${videos} видео`)
    return `Список — ${parts.join(', ') || 'пусто'}`
  }

  function appendListEntry(paths: string[]): PlaylistEntry[] {
    const items = toListItems(paths)
    if (items.length === 0) return []
    const entry: PlaylistEntry = {
      id: randomUUID(),
      kind: 'list',
      // Своего файла у списка нет — материалы лежат в items.
      filePath: '',
      fileName: listDisplayName(items),
      displayName: '',
      speakerName: '',
      durationMs: store.get().timer.durationMs,
      items,
      photoSec: DEFAULT_PHOTO_SEC,
      // Списки заводят ради «крутится по кругу» — цикл по умолчанию включён.
      loop: true,
    }
    store.patch({ playlist: [...store.get().playlist, entry] })
    persistPlaylist()
    return [entry]
  }

  function appendToPlaylist(paths: string[]): PlaylistEntry[] {
    const existing = store.get().playlist
    const defaultDur = store.get().timer.durationMs
    const newEntries: PlaylistEntry[] = []
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue
      const kind = kindOf(p)
      if (!kind) continue
      newEntries.push({
        id: randomUUID(),
        kind,
        filePath: p,
        fileName: kind === 'live' ? liveDisplayName(p) : basename(p),
        displayName: '',
        speakerName: '',
        durationMs: defaultDur,
        ...(kind === 'live' ? { liveFit: DEFAULT_LIVE_FIT } : {}),
      })
    }
    if (newEntries.length > 0) {
      store.patch({ playlist: [...existing, ...newEntries] })
      persistPlaylist()
      void refreshMissingFiles()
    }
    return newEntries
  }

  ipcMain.handle('playlist:add', async (): Promise<PlaylistEntry[]> => {
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: 'Добавить файлы в плейлист',
      filters: OPEN_DIALOG_FILTERS,
      properties: ['openFile', 'multiSelections'],
    })
    if (res.canceled || res.filePaths.length === 0) return []
    return appendToPlaylist(res.filePaths)
  })

  /**
   * Список: пачка фото и/или роликов одной записью плейлиста. Клиент принёс
   * 40 фотографий на сбор гостей — они не должны разъезжаться сорока строками
   * по списку спикеров.
   */
  ipcMain.handle('playlist:add-list', async (): Promise<PlaylistEntry[]> => {
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: 'Файлы для списка',
      message: 'Фотографии и ролики, которые пойдут по кругу',
      filters: [
        { name: 'Фото и видео', extensions: [...IMAGE_EXTS_ARR, ...VIDEO_EXTS_ARR] },
        { name: 'Изображения', extensions: IMAGE_EXTS_ARR },
        { name: 'Видео', extensions: VIDEO_EXTS_ARR },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (res.canceled || res.filePaths.length === 0) return []
    return appendListEntry(res.filePaths)
  })

  /** Правка содержимого списка: порядок, удаление, добавление, секунды на фото. */
  ipcMain.handle(
    'playlist:update-list',
    (
      _e,
      payload: {
        id: string
        items?: ListItem[]
        photoSec?: number
        listMode?: ListMode
        fadeMs?: number
      },
    ) => {
      const entry = store.get().playlist.find((x) => x.id === payload.id)
      if (!entry || entry.kind !== 'list') return
      const next = store.get().playlist.map((x) =>
        x.id === payload.id
          ? {
              ...x,
              items: payload.items ?? x.items,
              photoSec:
                typeof payload.photoSec === 'number' ? payload.photoSec : x.photoSec,
              listMode: payload.listMode ?? x.listMode,
              fadeMs: typeof payload.fadeMs === 'number' ? payload.fadeMs : x.fadeMs,
              fileName: listDisplayName(payload.items ?? x.items ?? []),
            }
          : x,
      )
      store.patch({ playlist: next })
      persistPlaylist()
      void refreshMissingFiles()
    },
  )

  /** Добавить файлы в существующий список. */
  ipcMain.handle('playlist:add-to-list', async (_e, id: string): Promise<boolean> => {
    const entry = store.get().playlist.find((x) => x.id === id)
    if (!entry || entry.kind !== 'list') return false
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: 'Добавить в список',
      filters: [{ name: 'Фото и видео', extensions: [...IMAGE_EXTS_ARR, ...VIDEO_EXTS_ARR] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (res.canceled || res.filePaths.length === 0) return false
    const items = [...(entry.items ?? []), ...toListItems(res.filePaths)]
    store.patch({
      playlist: store.get().playlist.map((x) =>
        x.id === id ? { ...x, items, fileName: listDisplayName(items) } : x,
      ),
    })
    persistPlaylist()
    void refreshMissingFiles()
    return true
  })

  /**
   * Живой вход в плейлист: устройство приходит метками (их знает только
   * рендерер — enumerateDevices живёт в вебе), здесь склеивается в псевдо-путь.
   * Имя записи оператор потом правит как у обычного файла («Ноут ведущего»).
   */
  ipcMain.handle('playlist:add-live', (_e, src: LiveSource): PlaylistEntry[] => {
    if (!src || typeof src.videoLabel !== 'string' || !src.videoLabel) return []
    return appendToPlaylist([
      makeLiveUri({ videoLabel: src.videoLabel, audioLabel: src.audioLabel || null }),
    ])
  })

  // Drag & drop из Finder/Explorer: пути приходят из рендерера (webUtils).
  ipcMain.handle('playlist:add-paths', (_e, paths: string[]): PlaylistEntry[] => {
    if (!Array.isArray(paths)) return []
    return appendToPlaylist(paths)
  })

  /**
   * Переназначить устройства у живого входа, не пересоздавая запись: смена
   * аудиовхода не должна стоить «удалить и завести заново». Меняется сам
   * псевдо-путь, поэтому деки, которые на него смотрят, переводим следом —
   * иначе эфир остался бы на старом источнике.
   */
  ipcMain.handle('playlist:update-live', (_e, payload: { id: string; src: LiveSource }) => {
    const entry = store.get().playlist.find((e) => e.id === payload.id)
    if (!entry || entry.kind !== 'live' || !payload.src?.videoLabel) return
    const oldPath = entry.filePath
    const uri = makeLiveUri({
      videoLabel: payload.src.videoLabel,
      audioLabel: payload.src.audioLabel || null,
    })
    if (uri === oldPath) return

    store.patch({
      playlist: store.get().playlist.map((e) =>
        e.id === payload.id ? { ...e, filePath: uri, fileName: liveDisplayName(uri) } : e,
      ),
    })
    persistPlaylist()

    if (store.get().pdfPath === oldPath) {
      store.patch({ pdfPath: uri, pdfSha1: uri })
      setLastPdfPath(uri)
    }
    if (store.get().preview.path === oldPath) {
      store.patchPreview({ path: uri, sha1: uri })
    }
  })

  ipcMain.handle('playlist:remove', (_e, id: string) => {
    const removed = store.get().playlist.find((e) => e.id === id)
    const next = store.get().playlist.filter((e) => e.id !== id)
    const patch: Partial<import('./state.js').AppState> = { playlist: next }
    if (store.get().currentPlaylistId === id) {
      patch.currentPlaylistId = null
      setCurrentPlaylistId(null)
    }
    store.patch(patch)
    // Живой вход держит железо занятым, пока на него кто-то смотрит. Убрали
    // запись — снимаем её и с превью, иначе устройство останется захваченным
    // невидимым деском. Эфир не трогаем: удаление строки не должно гасить зал.
    if (removed?.kind === 'live' && store.get().preview.path === removed.filePath) {
      store.patch({ preview: initialDeckState() })
    }
    // Удалили запись, которая крутится в эфире, — останавливаем проигрыватель,
    // иначе его таймер продолжит менять картинки от несуществующего списка.
    if (removed?.kind === 'list' && store.get().currentPlaylistId === id) stopListPlayback()
    persistPlaylist()
    // Чистим id удалённой записи из списка ненайденных.
    if (store.get().missingIds.includes(id)) void refreshMissingFiles()
  })

  ipcMain.handle('playlist:reorder', (_e, ids: string[]) => {
    const map = new Map(store.get().playlist.map((e) => [e.id, e]))
    const reordered = ids.map((id) => map.get(id)).filter((e): e is PlaylistEntry => Boolean(e))
    store.patch({ playlist: reordered })
    persistPlaylist()
  })

  ipcMain.handle(
    'playlist:update',
    (
      _e,
      payload: {
        id: string
        displayName?: string
        speakerName?: string
        durationMs?: number
        liveFit?: LiveFit
        loop?: boolean
      },
    ) => {
      const next = store.get().playlist.map((e) =>
        e.id === payload.id
          ? {
              ...e,
              displayName: payload.displayName ?? e.displayName,
              speakerName: payload.speakerName ?? e.speakerName,
              durationMs:
                typeof payload.durationMs === 'number' ? payload.durationMs : e.durationMs,
              liveFit: payload.liveFit ?? e.liveFit,
              loop: typeof payload.loop === 'boolean' ? payload.loop : e.loop,
            }
          : e,
      )
      store.patch({ playlist: next })
      persistPlaylist()

      // Запись сейчас в эфире — цикл должен примениться немедленно, не дожидаясь
      // следующей выдачи: оператор жмёт значок как раз по играющему ролику.
      if (typeof payload.loop === 'boolean' && store.get().currentPlaylistId === payload.id) {
        store.patch({ videoLoop: payload.loop })
      }

      // If the updated entry is the active one and duration changed, apply it
      if (
        typeof payload.durationMs === 'number' &&
        store.get().currentPlaylistId === payload.id
      ) {
        store.patchTimer({ durationMs: payload.durationMs })
        setLastDurationMs(payload.durationMs)
      }
    },
  )

  // Single click: stage into the off-air preview deck (safe — no air interruption).
  ipcMain.handle('playlist:activate', async (_e, id: string): Promise<OpenPdfResult> => {
    const entry = store.get().playlist.find((e) => e.id === id)
    if (!entry) return { ok: false, error: 'Entry not found' }
    // Список в превью показывает первый элемент — посмотреть, что за пачка.
    // Крутить её в превью незачем: это подготовка, а не эфир.
    if (entry.kind === 'list') {
      const first = entry.items?.[0]
      if (!first) return { ok: false, error: 'Список пуст — добавь фото или ролики' }
      store.patch({ previewListIndex: 0 })
      return loadPreview(first.path, { playlistId: id })
    }
    store.patch({ previewListIndex: -1 })
    return loadPreview(entry.filePath, { playlistId: id })
  })

  // Double click / explicit "to air": load straight to the program feed.
  ipcMain.handle('playlist:activate-live', async (_e, id: string): Promise<OpenPdfResult> => {
    const entry = store.get().playlist.find((e) => e.id === id)
    if (!entry) return { ok: false, error: 'Entry not found' }
    if (entry.kind === 'list') {
      if (!entry.items || entry.items.length === 0) {
        return { ok: false, error: 'Список пуст — добавь фото или ролики' }
      }
      await startListPlayback(id)
      return { ok: true, path: entry.items[0].path }
    }
    return openFile(entry.filePath, { playlistId: id, durationMs: entry.durationMs })
  })

  ipcMain.handle('playlist:set-compact', (_e, value: boolean) => {
    const v = Boolean(value)
    store.patch({ playlistCompact: v })
    setPlaylistCompact(v)
  })

  ipcMain.handle('playlist:set-auto-advance', (_e, value: boolean) => {
    const v = Boolean(value)
    store.patch({ autoAdvance: v })
    setAutoAdvance(v)
  })

  ipcMain.handle('keyvisual:set', async (): Promise<{ path: string | null }> => {
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: 'Выбрать заставку (key visual)',
      filters: [
        { name: 'Картинка или видео', extensions: [...IMAGE_EXTS_ARR, 'gif', ...VIDEO_EXTS_ARR] },
        { name: 'Изображения', extensions: [...IMAGE_EXTS_ARR, 'gif'] },
        { name: 'Видео', extensions: VIDEO_EXTS_ARR },
      ],
      properties: ['openFile'],
    })
    if (res.canceled || res.filePaths.length === 0) return { path: store.get().keyVisualPath }
    const path = res.filePaths[0]
    store.patch({ keyVisualPath: path })
    setKeyVisualPath(path)
    return { path }
  })

  ipcMain.handle('keyvisual:clear', () => {
    store.patch({ keyVisualPath: null })
    setKeyVisualPath(null)
  })

  ipcMain.handle('keyvisual:read', async (): Promise<{ bytes: Uint8Array; mime: string } | null> => {
    const path = store.get().keyVisualPath
    if (!path) return null
    // Видео-заставка отдаётся потоком через cuedeck-media://stream/keyvisual —
    // читать многогигабайтный файл в память нельзя.
    if (kindOf(path) === 'video') return null
    try {
      const buf = await readFile(path)
      const ext = path.toLowerCase().split('.').pop() ?? ''
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
      }
      return {
        bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        mime: mimeMap[ext] ?? 'application/octet-stream',
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('soffice:check', async () => {
    return Boolean(await findSoffice())
  })

  /** Кнопка «Проверить снова» после установки — сбрасывает кэш пути. */
  ipcMain.handle('soffice:recheck', async () => Boolean(await recheckSoffice()))

  /** Где искали — показываем в подсказке, если LibreOffice так и не нашёлся. */
  ipcMain.handle('soffice:paths', () => sofficeSearchPaths())

  /**
   * Указать LibreOffice вручную: сканирование стандартных папок не спасает,
   * если человек ставит всё на диск D. Выбранный файл проверяем запуском
   * `--version` — иначе неверный exe всплыл бы ошибкой уже на мероприятии.
   */
  ipcMain.handle('soffice:pick', async (): Promise<{ ok: boolean; path?: string }> => {
    const op = getOperatorWindow()
    const win = process.platform === 'win32'
    const res = await dialog.showOpenDialog(op!, {
      title: 'Укажи, где установлен LibreOffice',
      defaultPath: win ? 'C:\\Program Files' : '/Applications',
      // На macOS бандл .app выбирается как файл — нужен openDirectory-обход.
      properties: win ? ['openFile'] : ['openFile', 'treatPackageAsDirectory'],
      filters: win
        ? [{ name: 'LibreOffice', extensions: ['com', 'exe'] }]
        : [{ name: 'LibreOffice', extensions: ['app', ''] }],
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false }
    const path = await setManualSoffice(res.filePaths[0])
    return path ? { ok: true, path } : { ok: false }
  })

  ipcMain.handle('state:get', () => store.get())

  ipcMain.handle('sidecar:path', (_e, pdfPath: string) => sidecarPathFor(pdfPath))

  // ── Session restore ────────────────────────────────────────────────────────

  /** Returns true if there is a previous session worth restoring. */
  ipcMain.handle('session:has-last', () => {
    return Boolean(getLastPdfPath()) || getPlaylist().length > 0
  })

  /** Restores the last session: playlist, key visual, project path, and last open file. */
  ipcMain.handle('session:restore', async (): Promise<OpenPdfResult & { hadSession: boolean }> => {
    const lastPath = getLastPdfPath()
    const savedPlaylist = getPlaylist()
    const savedPlaylistId = getCurrentPlaylistId()
    const savedKeyVisual = getKeyVisualPath()
    const savedProjectPath = getProjectPath()

    store.patch({
      playlist: savedPlaylist,
      currentPlaylistId: savedPlaylistId,
      keyVisualPath: savedKeyVisual,
      projectPath: savedProjectPath,
    })

    void refreshMissingFiles()

    if (!lastPath) {
      return { ok: true, hadSession: savedPlaylist.length > 0 }
    }

    const entry = savedPlaylistId ? savedPlaylist.find((e) => e.id === savedPlaylistId) : undefined
    const result = await openFile(lastPath, {
      playlistId: savedPlaylistId,
      durationMs: entry?.durationMs,
    })
    return { ...result, hadSession: true }
  })

  ipcMain.handle('project:new', () => {
    stopListPlayback()
    // Intentionally do NOT clear persistent storage (lastPdfPath, playlist,
    // keyVisualPath, projectPath) — this keeps session:has-last returning true
    // so the user can restore the previous session via "Последний" after reset.
    store.patch({
      playlist: [],
      currentPlaylistId: null,
      keyVisualPath: null,
      projectPath: null,
      pdfPath: null,
      pdfSha1: null,
      fileKind: null,
      totalSlides: 0,
      currentSlide: 1,
      notes: {},
      slideMedia: [],
      blackout: false,
      preview: initialDeckState(),
      speakerMessage: null,
    })
  })

  ipcMain.handle(
    'project:save',
    async (_e, payload: { saveAs?: boolean } = {}) => saveProject(Boolean(payload.saveAs)),
  )

  ipcMain.handle(
    'project:open',
    async (): Promise<{
      ok: boolean
      path?: string
      error?: string
      missing?: number
      total?: number
    }> => {
      const op = getOperatorWindow()
      const res = await dialog.showOpenDialog(op!, {
        title: 'Открыть проект',
        filters: [{ name: 'CueDeck project', extensions: [PROJECT_EXTENSION] }],
        properties: ['openFile'],
      })
      if (res.canceled || res.filePaths.length === 0) return { ok: false }
      const path = res.filePaths[0]
      try {
        const loaded = await loadProjectFile(path)
        store.patch({
          playlist: loaded.playlist,
          keyVisualPath: loaded.keyVisualPath,
          currentPlaylistId: null,
          projectPath: path,
          pdfPath: null,
          pdfSha1: null,
          fileKind: null,
          totalSlides: 0,
          currentSlide: 1,
          notes: {},
          slideMedia: [],
          preview: initialDeckState(),
        })
        persistPlaylist()
        setKeyVisualPath(loaded.keyVisualPath)
        setCurrentPlaylistId(null)
        setProjectPath(path)
        setLastPdfPath(null)
        // Проверяем материалы сразу: пропажу оператор должен увидеть при
        // открытии проекта, а не когда нажмёт ЭФИР.
        const missing = await refreshMissingFiles()
        return { ok: true, path, missing, total: loaded.playlist.length }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  )

  /**
   * Перепривязка одной папкой (шаг 3): оператор указывает, куда переехали
   * материалы, мы сами ищем в ней пропавшие по имени файла. Сценарий «навёл
   * порядок и скомпоновал всё в одно место» — десять записей чинятся одним
   * действием, комментарии и таймеры остаются.
   */
  ipcMain.handle(
    'playlist:relink-folder',
    async (): Promise<{ fixed: number; remaining: number; cancelled?: boolean }> => {
      const missingIds = new Set(store.get().missingIds)
      if (missingIds.size === 0) return { fixed: 0, remaining: 0 }
      const op = getOperatorWindow()
      const res = await dialog.showOpenDialog(op!, {
        title: 'Где теперь лежат материалы?',
        message: 'Выбери папку — файлы найдутся в ней и во вложенных папках по именам',
        properties: ['openDirectory'],
      })
      if (res.canceled || res.filePaths.length === 0) {
        return { fixed: 0, remaining: missingIds.size, cancelled: true }
      }

      const index = await indexFolder(res.filePaths[0])
      let fixed = 0
      const playlist = store.get().playlist.map((e) => {
        if (!missingIds.has(e.id) || e.kind === 'live') return e
        if (e.kind === 'list') {
          let touched = false
          const items = (e.items ?? []).map((it) => {
            const hit = index.get(basename(it.path).toLowerCase())
            if (!hit || hit.length === 0) return it
            const p = pickBestCandidate(hit)
            if (p === it.path) return it
            touched = true
            return { ...it, path: p, fileName: basename(p) }
          })
          if (touched) fixed += 1
          return touched ? { ...e, items } : e
        }
        const found = index.get(basename(e.filePath).toLowerCase())
        if (!found || found.length === 0) return e
        const picked = pickBestCandidate(found)
        const kind = kindOf(picked)
        if (!kind || kind === 'live') return e
        fixed += 1
        return { ...e, filePath: picked, fileName: basename(picked), kind }
      })

      if (fixed > 0) {
        store.patch({ playlist })
        persistPlaylist()
      }
      const remaining = await refreshMissingFiles()
      return { fixed, remaining }
    },
  )

  /**
   * Собрать проект в папку (шаг 4): копируем все материалы в подпапку рядом с
   * .pdpres и переписываем пути — на выходе самодостаточная папка под флешку,
   * которая откроется на любой машине (пути станут относительными, см.
   * project.ts). Пропавшие файлы копировать нечего — сообщаем сколько.
   */
  ipcMain.handle(
    'project:consolidate',
    async (): Promise<{
      ok: boolean
      copied?: number
      skipped?: number
      path?: string
      error?: string
      cancelled?: boolean
    }> => {
      const op = getOperatorWindow()
      const state = store.get()
      if (state.playlist.length === 0 && !state.keyVisualPath) {
        return { ok: false, error: 'Проект пуст — нечего собирать' }
      }
      const res = await dialog.showOpenDialog(op!, {
        title: 'Куда собрать проект',
        message: 'Выбери папку — внутри появится папка проекта со всеми материалами',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (res.canceled || res.filePaths.length === 0) return { ok: false, cancelled: true }

      const projectName = state.projectPath
        ? basename(state.projectPath, `.${PROJECT_EXTENSION}`)
        : 'CueDeck-проект'
      const targetDir = join(res.filePaths[0], projectName)
      const mediaDir = join(targetDir, 'материалы')

      try {
        await mkdir(mediaDir, { recursive: true })
        const taken = new Set<string>()
        let copied = 0
        let skipped = 0

        // Один и тот же файл может стоять в плейлисте дважды (тот же ролик у
        // двух спикеров) — копируем его один раз, иначе двухгиговое видео
        // ляжет в папку двумя копиями.
        const copiedByPath = new Map<string, string>()

        const copyMaterial = async (src: string): Promise<string | null> => {
          const already = copiedByPath.get(src)
          if (already) return already
          try {
            await access(src)
          } catch {
            skipped += 1
            return null
          }
          const name = uniqueName(basename(src), taken)
          const dest = join(mediaDir, name)
          await copyFile(src, dest)
          copiedByPath.set(src, dest)
          copied += 1
          return dest
        }

        const playlist: PlaylistEntry[] = []
        for (const e of state.playlist) {
          if (e.kind === 'live') {
            playlist.push(e) // живой вход копировать нечего
            continue
          }
          if (e.kind === 'list') {
            const items = []
            for (const it of e.items ?? []) {
              const dest = await copyMaterial(it.path)
              items.push(dest ? { ...it, path: dest } : it)
            }
            playlist.push({ ...e, items })
            continue
          }
          const dest = await copyMaterial(e.filePath)
          playlist.push(dest ? { ...e, filePath: dest } : e)
        }
        const keyVisualPath = state.keyVisualPath
          ? ((await copyMaterial(state.keyVisualPath)) ?? state.keyVisualPath)
          : null

        // Заметки-спутники живут рядом с исходником и ключуются по SHA1 —
        // копия файла та же, поэтому переносим их следом, иначе заметки
        // спикеров потеряются при переезде.
        for (const e of playlist) {
          if (e.kind === 'live' || e.kind === 'list') continue
          const oldPath = state.playlist.find((x) => x.id === e.id)?.filePath
          // Материал не скопировался (не найден) — путь остался прежним, и
          // копирование заметок «само в себя» затёрло бы их.
          if (!oldPath || oldPath === e.filePath) continue
          const from = sidecarPathFor(oldPath)
          const to = sidecarPathFor(e.filePath)
          try {
            await access(from)
            await copyFile(from, to)
          } catch {
            /* заметок нет — нормально */
          }
        }

        const projectPath = join(targetDir, `${projectName}.${PROJECT_EXTENSION}`)
        await saveProjectFile(projectPath, { playlist, keyVisualPath })

        store.patch({ playlist, keyVisualPath, projectPath })
        persistPlaylist()
        setKeyVisualPath(keyVisualPath)
        setProjectPath(projectPath)
        await refreshMissingFiles()
        return { ok: true, copied, skipped, path: projectPath }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  )

  /** Ручная перепроверка материалов — кнопка «Проверить файлы» у оператора. */
  ipcMain.handle(
    'playlist:check-files',
    async (): Promise<{ missing: number; total: number }> => {
      const missing = await refreshMissingFiles()
      return { missing, total: store.get().playlist.length }
    },
  )

  /**
   * Указать файл заново для конкретной записи: материал переехал, но запись со
   * всеми настройками (комментарий, имя, таймер) должна остаться. Меняем путь,
   * имя файла и kind — вместо «удалить и завести заново».
   */
  ipcMain.handle('playlist:relocate', async (_e, id: string): Promise<boolean> => {
    const entry = store.get().playlist.find((e) => e.id === id)
    // У списка материалов много — их чинит «Найти в папке…» или правка списка.
    if (!entry || entry.kind === 'live' || entry.kind === 'list') return false
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: `Указать файл для «${entry.displayName || entry.fileName}»`,
      filters: OPEN_DIALOG_FILTERS,
      properties: ['openFile'],
    })
    if (res.canceled || res.filePaths.length === 0) return false
    const picked = res.filePaths[0]
    const kind = kindOf(picked)
    if (!kind || kind === 'live') return false
    store.patch({
      playlist: store.get().playlist.map((e) =>
        e.id === id ? { ...e, filePath: picked, fileName: basename(picked), kind } : e,
      ),
    })
    persistPlaylist()
    await refreshMissingFiles()
    return true
  })
}

export async function flushPendingWrites(): Promise<void> {
  await notesWriter.flush()
}
