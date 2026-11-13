import { mediaDirFor } from './pptx-media.js'
import type { SlideBuildAnimation } from '../shared/types.js'
import { hasLastSession, listSessionBackups } from './session-files.js'
import { timerFont } from '../shared/timer-font.js'
import { timerAdjustments } from '../shared/timer-controls.js'
import { materialTakeTimer, sanitizeMaterialSettings, validMaterialDuration } from '../shared/material-settings.js'
import { setMaterialSettings } from './display-mapping.js'
import { initialSlideVideo } from '../shared/slide-video.js'
import { slideNavigationPatch, sanitizeSlideFadeMs } from '../shared/slide-transition.js'
import { clearSessionDecks, restoreSessionDecks } from './session-restore.js'
import { assertSessionIdle, waitForSessionRestore, beginSessionRestore, finishSessionRestore, beginEmptyProject, finishEmptyProject, configureStartup, flushSessionCheckpoint, initSessionLifecycle, shouldRestoreAtStartup } from './session-lifecycle.js'
import { recoveryTakeFrame } from '../shared/recovery-take.js'
import { togglePreviewSourceMute } from '../shared/source-audio.js'
import { createClickerNavigation } from './clicker-navigation.js'
import { mobileClickerStorage } from './mobile-clicker-storage.js'
import { defaultSpeakerTimerStyle } from '../shared/speaker-timer-style.js'
import { MobileClicker } from './mobile-clicker.js'
import { programOverlay } from '../shared/program-overlay.js'
import { timerView } from '../renderer/shared/timer.js'
import { audienceTimerConfig, createAudienceTimer } from '../shared/audience-timer.js'
import { createAudienceTimerCommands } from './audience-timer.js'
import { getAudienceTimer, setAudienceTimer } from './display-mapping.js'
import { createClickerShortcutManager } from './clicker-shortcuts.js'
import { normalizeFolderPlaylist, reorderFolderPlaylist, insertPlaylistEntries, removePlaylistFolder, nextPlaylistFolderName, assignPlaylistFolders, duplicatePlaylistEntry, type PlaylistInsertPosition } from '../shared/playlist-folders.js'
import { sanitizeSpeakerToolbarScale } from '../shared/prompter-toolbar.js'
import { sanitizeTakeFadeMs, type TakeTransition } from '../shared/take-transition.js'
import {
  clampVideoPosition,
  endVideo,
  entryVideoRange,
  isVideoAtStart,
  normalizeVideoRange,
  planVideoTake,
  reusedVideoDuration,
  playVideoFrom,
  seekVideoTo,
  videoRangeEnd,
  videoRangeStart,
} from '../shared/video-range.js'
import { frameTimelines } from './frame-timeline.js'
import { VideoInOutController } from './video-inout.js'
import { VideoBoundaryScheduler } from './video-boundary.js'
import { autoVideoIdentity, autoVideoStillTargets, autoVideoTarget } from '../shared/video-auto-advance.js'
import { registerVideoInOutIpc } from './video-inout-ipc.js'
import { app, dialog, globalShortcut, ipcMain, screen, shell } from 'electron'
import { homedir } from 'node:os'
import { access, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'
import type { DisplayMap, Layout } from './layout.js'
import type {
  AppState,
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
import { getLang, parseLang, t } from '../shared/i18n.js'
import { isLiveUri, liveDisplayName, makeLiveUri, parseLiveUri } from '../shared/live.js'
import type { LiveSource } from '../shared/live.js'
import { computePdfSha1, computeStatSha1, loadNotes, notesWriter, sha1FromBuffer, sidecarPathFor } from './notes-store.js'
import { applyLayout, getOperatorWindow, getActiveWindows, ghostWindow } from './windows.js'
import {
  saveMapping,
  getLastPdfPath,
  getPlaylist,
  getPlaylistFolders,
  getCurrentPlaylistId,
  getKeyVisualPath,
  getProjectPath,
  setLastPdfPath,
  setLastDurationMs,
  setTimerMode,
  setTimerPosition,
  setTimerScale,
  setTimerFree,
  setTimerFont,
  setTimerColor,
  validTimerColor,
  setTimerWarnColors,
  setSpeakerToolbarScale,
  setSpeakerLayout,
  sanitizeSpeakerLayout,
  setSpeakerMsgLayout,
  sanitizeSpeakerMsgLayout,
  setVideoTakeMode,
  setSlideTakeMode,
  setTakeFadeMs,
  setNotesFontSize,
  setPlaylist,
  setPlaylistFolders,
  setCurrentPlaylistId,
  setKeyVisualPath,
  setProjectPath,
  setPlaylistCompact,
  setAutoAdvance,
  setAudienceWindowed,
  setAudienceAlwaysOnTop,
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
  setTimerAdjustments,
  setOutputMonitorsEnabled,
  setUiTheme,
  getUiLang,
  setUiLang,
} from './display-mapping.js'
import { indexFolder, pickBestCandidate } from './project-files.js'
import { countPdfPages } from './pdf-pages.js'
import { cachedPdfPathFor, findSoffice, LibreOfficeMissingError, recheckSoffice, setManualSoffice, sofficeSearchPaths } from './pptx-converter.js'
import { beginProjectTransfer, endProjectTransfer, isProjectTransferRunning, transferProject } from './project-transfer.js'
import { runPptxWork } from './pptx-work.js'
import { presentationNotesPath } from './presentation-notes-path.js'
import { preparePresentation, cancelPresentationPreparations, cancelPresentationPreparation, onPreparationStatus, getPptxBackend, setPptxBackend } from './presentation-preparation.js'
import { PreparationUiState } from './preparation-ui-state.js'
import type { ProjectTransferStatus } from '../shared/types.js'
import { clearLocalCache, exportProjectCache, localCacheStats, localPptxCacheDir } from './project-cache.js'
import { log, setRecoveryStager } from './diag.js'
import { adjustPatch } from '../renderer/shared/timer.js'
import { addFonts, addedFontsCount, removeAddedFonts, type FontHooks } from './user-fonts.js'
import { installWinFont, uninstallWinFont } from './win-fonts.js'
import {
  loadProjectFile,
  PROJECT_EXTENSION,
  saveProjectFile,
  flushProjectWrites,
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

// Функция, а не константа: подписи на языке интерфейса, а он известен только после старта.
const openDialogFilters = (): Electron.FileFilter[] => [
  { name: t('Все поддерживаемые'), extensions: ALL_SUPPORTED_EXTS },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'PowerPoint / Keynote', extensions: ['pptx', 'ppt', 'odp', 'key'] },
  { name: t('Видео'), extensions: VIDEO_EXTS_ARR },
  { name: t('Изображения'), extensions: IMAGE_EXTS_ARR },
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
  slideTransitions?: Record<number, number>
  slideBuilds?: Record<number, SlideBuildAnimation>
}

/**
 * Заметки докладчика из PPTX (2.23) по sha1 файла. Нужны при записи заметок:
 * в файл-спутник уходит только то, что оператор правил сам, — иначе копия
 * заметок PowerPoint застряла бы в нём и перекрыла обновлённую презентацию.
 */
const pptxNotesBySha1 = new Map<string, Record<number, string>>()
const pptxNotesPathBySha1 = new Map<string, string>()

/** Что писать в файл-спутник: всё, кроме страниц, совпадающих с заметкой PPTX. */
function ownNotes(sha1: string, notes: Record<number, string>): Record<number, string> {
  const fromFile = pptxNotesBySha1.get(sha1)
  if (!fromFile) return notes
  const out: Record<number, string> = {}
  for (const [k, v] of Object.entries(notes)) {
    if (fromFile[Number(k)] !== v) out[Number(k)] = v
  }
  return out
}

/** Запомнить, какие шрифты PPTX подменены; патч только при изменении. */
function setFontIssues(filePath: string, fonts: string[]): void {
  const cur = store.get().fontIssues
  const had = cur[filePath]
  if (fonts.length === 0 && !had) return
  if (had && had.length === fonts.length && had.every((f, i) => f === fonts[i])) return
  const next = { ...cur }
  if (fonts.length > 0) next[filePath] = fonts
  else delete next[filePath]
  store.patch({ fontIssues: next })
  if (fonts.length > 0) log.warn(`[fonts] ${filePath}: подменены ${fonts.join(', ')}`) // i18n-ok
}

/** Read a file's identity + page count + sidecar notes. Shared by both decks. */
const preparationUi = new PreparationUiState(store, preparePresentation, cancelPresentationPreparations,
  (path, prepared, options) => {
    if (options.reportFontIssues !== false) setFontIssues(path, prepared.fonts)
  })
let programOpenGeneration = 0
let previewOpenGeneration = 0
let pendingDeckLoads = 0
function resetPreparation(): void {
  programOpenGeneration++
  previewOpenGeneration++
  preparationUi.reset()
}

async function inspectFile(filePath: string, opts: { forceLocalCache?: boolean; cacheSourcePath?: string; cacheProjectPath?: string | null; reportFontIssues?: boolean } = {}): Promise<InspectedFile> {
  if (store.get().testScreen.automatic) store.patch({ testScreen: { ...store.get().testScreen, automatic: false } })
  const kind = kindOf(filePath)
  if (!kind) throw new Error(t('Неподдерживаемый формат файла'))

  // Живой вход: файла нет — ни читать, ни считать страницы, ни искать заметки.
  // Идентичность = сам псевдо-путь (сменил устройство → сменился «файл»).
  if (kind === 'live') {
    if (!parseLiveUri(filePath)) throw new Error(t('Неверно задан внешний вход'))
    return { kind, sha1: filePath, totalSlides: 1, notes: {}, sha1Mismatch: false, slideMedia: [] }
  }

  let sha1: string
  let notesPath = filePath
  let totalSlides = 1
  let slideMedia: SlideMedia[] = []
  let slideTransitions: Record<number, number> = {}
  let slideBuilds: Record<number, SlideBuildAnimation> = {}
  let pptxNotes: Record<number, string> = {}

  if (kind === 'pdf') {
    // Single read: compute SHA1 and count pages from the same buffer.
    const buf = await readFile(filePath)
    sha1 = sha1FromBuffer(buf)
    totalSlides = countPdfPages(buf)
  } else if (kind === 'pptx') {
    const prepared = await preparationUi.prepare(filePath, {
      ...opts, priority: 'foreground',
      cacheProjectPath: opts.cacheProjectPath === undefined ? store.get().projectPath : opts.cacheProjectPath,
    })
    sha1 = prepared.sha1
    // Static PDF pages can differ from LibreOffice's animation-step pages.
    // Keep operator edits in a separate sidecar so page N never inherits a
    // note written for a different slide under the other exporter.
    notesPath = presentationNotesPath(filePath, sha1, prepared.sourceSha1)
    pptxNotesPathBySha1.set(sha1, notesPath)
    totalSlides = prepared.totalSlides
    slideMedia = prepared.slideMedia
    slideTransitions = prepared.slideTransitions ?? {}
    slideBuilds = prepared.slideBuilds ?? {}
    pptxNotes = prepared.pageNotes
    pptxNotesBySha1.set(sha1, pptxNotes)
  } else if (kind === 'video') {
    // video: don't read the whole (possibly multi-GB) file — id from stat only
    sha1 = await computeStatSha1(filePath)
  } else {
    // image: totalSlides stays 1, just need SHA1
    sha1 = await computePdfSha1(filePath)
  }

  const loaded = await loadNotes(notesPath, sha1)
  return {
    kind,
    sha1,
    totalSlides,
    // Своя правка оператора главнее, в том числе пустая (стёр заметку
    // PowerPoint — не возвращаем); остальные страницы — из PPTX.
    notes: { ...pptxNotes, ...loaded.notes },
    sha1Mismatch: loaded.sha1Mismatch,
    slideMedia,
    slideTransitions,
    slideBuilds,
  }
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
async function playListItem(entryId: string, pos: number, transition?: TakeTransition): Promise<void> {
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
  const res = await openFile(item.path, { playlistId: entryId, fromList: true, transition })
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
export async function startListPlayback(entryId: string, transition?: TakeTransition): Promise<void> {
  await playListItem(entryId, 0, transition)
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
  return t('Файл не найден: {name} — материал переехал. Нажми «Указать файл…» на карточке', { name: basename(filePath) })
}

/** Abort an ffprobe run only when no deck still points at that file. */
function cancelFrameProbeIfUnused(path: string | null): void {
  if (!path) return
  const state = store.get()
  if (state.pdfPath === path || state.preview.path === path) return
  frameTimelines.cancel(path)
}

async function openFile(
  filePath: string,
  opts: { playlistId?: string | null; durationMs?: number; fromList?: boolean; startOnTake?: boolean; transition?: TakeTransition; restorePaused?: boolean; expectedProgram?: string; autoPlayVideo?: boolean } = {},
): Promise<OpenPdfResult> {
  const generation = ++programOpenGeneration
  pendingDeckLoads++
  // Любая загрузка в эфир мимо проигрывателя снимает список с эфира — иначе
  // его таймер продолжил бы подменять картинку под уже другим материалом.
  if (!opts.fromList) stopListPlayback()
  const previousFramePath = store.get().fileKind === 'video' ? store.get().pdfPath : null
  try {
    const info = await inspectFile(filePath)
    if (generation !== programOpenGeneration) return { ok: false, cancelled: true }
    if (opts.expectedProgram && autoVideoIdentity(store.get()) !== opts.expectedProgram) return { ok: false, cancelled: true }
    if (opts.expectedProgram && !autoVideoStillTargets(store.get(), opts.playlistId, filePath)) return { ok: false, cancelled: true }
    if (opts.playlistId && !store.get().playlist.some(e => e.id === opts.playlistId)) return { ok: false, cancelled: true }
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
    // A duplicate/direct activation of the same path+sha reuses the decoder and
    // its already-known duration; resetting it to 0 left the renderer unable to
    // report metadata again (same <source> does not always emit loadedmetadata).
    const beforeProgram = store.get()
    const reusedDuration = info.kind === 'video'
      ? reusedVideoDuration(
          { path: beforeProgram.pdfPath, sha1: beforeProgram.pdfSha1, kind: beforeProgram.fileKind, video: beforeProgram.video },
          filePath, info.sha1, info.kind,
        )
      : 0
    // Applied range snapshot. Editing this entry's In/Out later updates the
    // clock immediately too (same entry id), not only on the next TAKE.
    const entryRange = info.kind === 'video' ? entryVideoRange(entry, reusedDuration) : null

    store.patch({
      // У списка `loop` — про всю пачку, а не про отдельный ролик внутри неё:
      // элемент доигрывает и уступает место следующему.
      videoLoop: Boolean(entry?.loop) && entry?.kind !== 'list',
      takeTransition: opts.transition ?? null,
      pdfPath: filePath,
      pdfSha1: info.sha1,
      fileKind: info.kind,
      totalSlides: info.totalSlides,
      currentSlide: 1,
      notes: info.notes,
      slideMedia: info.slideMedia,
      slideTransitions: info.slideTransitions ?? {},
      slideBuilds: info.slideBuilds ?? {},
      currentPlaylistId: playlistId,
      sourceMuted: entry?.sourceMuted === true,
      // Reset the playback clock for every file load; keep audience-mute preference.
      video: {
        playing: info.kind === 'video' && opts.autoPlayVideo === true,
        anchorSec: entryRange?.inSec ?? 0,
        anchorAt: info.kind === 'video' && opts.autoPlayVideo === true ? Date.now() : null,
        durationSec: reusedDuration,
        muted: store.get().video.muted,
        range: entryRange,
      },
      ...(info.kind === 'pptx' ? (() => {
        const initial = initialSlideVideo(info.kind, info.slideMedia, 1, store.get().video.muted)
        return opts.restorePaused && initial.video ? { ...initial, video: { ...initial.video, playing: false, anchorAt: null } } : initial
      })() : {}),
    })
    store.patchTimer(typeof opts.durationMs === 'number'
      ? materialTakeTimer(opts.durationMs, info.kind, store.get().timerMode, opts.startOnTake === true && store.get().materialSettings.autoStartTimer, Date.now())
      : timerPatch)

    if (previousFramePath && previousFramePath !== filePath) cancelFrameProbeIfUnused(previousFramePath)
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
    if (generation !== programOpenGeneration) return { ok: false, cancelled: true }
    return { ok: false, error: openErrorMessage(err, filePath), needsLibreOffice: err instanceof LibreOfficeMissingError || (err as { code?: string }).code === 'libreoffice_missing' }
  } finally {
    pendingDeckLoads--
  }
}

/** Load a file into the off-air PREVIEW deck (does not touch the audience feed). */
async function loadPreview(
  filePath: string,
  opts: { playlistId?: string | null } = {},
): Promise<OpenPdfResult> {
  const generation = ++previewOpenGeneration
  pendingDeckLoads++
  const previousFramePath = store.get().preview.kind === 'video' ? store.get().preview.path : null
  try {
    const info = await inspectFile(filePath)
    if (generation !== previewOpenGeneration) return { ok: false, cancelled: true }
    if (opts.playlistId && !store.get().playlist.some(e => e.id === opts.playlistId)) return { ok: false, cancelled: true }
    const playlistId = opts.playlistId ?? null
    const entry = playlistId ? store.get().playlist.find((e) => e.id === playlistId) : undefined
    const beforePreview = store.get().preview
    const reusedDuration = info.kind === 'video'
      ? reusedVideoDuration(beforePreview, filePath, info.sha1, info.kind)
      : 0
    const entryRange = info.kind === 'video' ? entryVideoRange(entry, reusedDuration) : null
    store.patchPreview({
      recoveryTake: false,
      path: filePath,
      sha1: info.sha1,
      kind: info.kind,
      totalSlides: info.totalSlides,
      currentSlide: 1,
      notes: info.notes,
      playlistId,
      sourceMuted: entry?.sourceMuted === true,
      slideMedia: info.slideMedia,
      slideTransitions: info.slideTransitions ?? {},
      slideBuilds: info.slideBuilds ?? {},
      video: {
        playing: false,
        anchorSec: entryRange?.inSec ?? 0,
        anchorAt: null,
        durationSec: reusedDuration,
        muted: true,
        range: entryRange,
      },
    })
    if (previousFramePath && previousFramePath !== filePath) cancelFrameProbeIfUnused(previousFramePath)
    return {
      ok: true,
      path: filePath,
      totalSlides: info.totalSlides,
      sha1: info.sha1,
      sha1Mismatch: info.sha1Mismatch,
      kind: info.kind,
    }
  } catch (err) {
    if (generation !== previewOpenGeneration) return { ok: false, cancelled: true }
    return { ok: false, error: openErrorMessage(err, filePath), needsLibreOffice: err instanceof LibreOfficeMissingError || (err as { code?: string }).code === 'libreoffice_missing' }
  } finally {
    pendingDeckLoads--
  }
}

/** Entering a PPTX slide restarts its clip using the source playback policy. */
function changeProgramSlide(slide: number): void {
  const patch = slideNavigationPatch(store.get(), slide, randomUUID())
  if (patch) store.patch(patch)
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
    const m = state.slideMedia.find((mm) => mm.slide === currentSlide && mm.kind !== 'gif')
    if (m) {
      store.patchVideo({ playing: true, anchorSec: 0, anchorAt: Date.now() })
      return
    }
  }

  // Файл-видео в эфире (Б-2): та же механика, что и у слайд-видео выше —
  // неигравший ролик (позиция 0, после автоперехода плейлиста) первый клик
  // «далее» запускает; играющий/отмотанный — прежняя перемотка +5с кликера.
  if (state.fileKind === 'video') {
    const position = store.videoPositionSec()
    if (!state.video.playing && isVideoAtStart(position, state.video.range, state.video.durationSec)) {
      store.patchVideo({
        playing: true,
        anchorSec: videoRangeStart(state.video.range, state.video.durationSec),
        anchorAt: Date.now(),
      })
    } else {
      programSeekBy(5)
    }
    return
  }

  // Живой вход: листать и перематывать нечего. Молчим намеренно — иначе
  // случайный клик спикера увёл бы эфир на следующего по autoAdvance.
  if (state.fileKind === 'live') return

  if (currentSlide < totalSlides) {
    changeProgramSlide(currentSlide + 1)
    return
  }
  if (!autoAdvance || !currentPlaylistId || playlist.length === 0) return
  const idx = playlist.findIndex((e) => e.id === currentPlaylistId)
  if (idx < 0 || idx >= playlist.length - 1) return
  const next = playlist[idx + 1]
  await openFile(next.filePath, { playlistId: next.id, durationMs: next.durationMs, startOnTake: true })
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
    changeProgramSlide(state.currentSlide - 1)
  }
}

function programSeekBy(deltaSec: number): void {
  const v = store.get().video
  const delta = Number.isFinite(deltaSec) ? deltaSec : 0
  store.patchVideo(seekVideoTo(v, store.videoPositionSec() + delta))
}

/**
 * Global clicker via globalShortcut: the speaker keeps flipping the program
 * deck while the operator works in another app (browser, Finder — e.g.
 * downloading the next presentation mid-show). Mirrors the renderer's clicker
 * behaviour: standalone videos ignore navigation, presentations advance. Blank (.) and
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
const clickerNavigation = createClickerNavigation(() => store.get().fileKind, programNext, programPrev)
const mobileClicker = new MobileClicker(() => {
  const state = store.get()
  return { current: state.currentSlide, total: state.totalSlides,
    remaining: Math.max(0, state.totalSlides - state.currentSlide),
    canNavigate: Boolean(state.pdfPath) && (state.fileKind === 'pdf' || state.fileKind === 'pptx'),
    timer: timerView(state.timer, state.timerMode) }
}, direction => { log.info('clicker:mobile', direction); return clickerNavigation[direction]() }, undefined, undefined, mobileClickerStorage)
app.once('will-quit', () => { void mobileClicker.dispose() })
const clickerShortcuts = createClickerShortcutManager(
  globalShortcut,
  () => Boolean(getOperatorWindow()?.isFocused()),
  () => { log.info('clicker:global-next'); void clickerNavigation.next() },
  () => { log.info('clicker:global-prev'); void clickerNavigation.prev() },
)
export const applyClickerShortcuts = clickerShortcuts.apply
export const suspendClickerShortcuts = clickerShortcuts.suspend

function persistPlaylist(): void {
  setPlaylist(store.get().playlist)
  setPlaylistFolders(store.get().playlistFolders)
}

const videoInOut = new VideoInOutController(store, frameTimelines, persistPlaylist)
let autoVideoPending: string | null = null
const autoVideoAdvance = {
  eligible: (state: AppState): boolean => autoVideoPending ? autoVideoIdentity(state) === autoVideoPending : Boolean(autoVideoTarget(state)),
  run: (state: AppState): boolean => {
    if (autoVideoPending) return autoVideoIdentity(state) === autoVideoPending
    const target = autoVideoTarget(state)
    if (!target) return false
    if ('slide' in target) { changeProgramSlide(target.slide); return true }
    const entry = state.playlist.find(e => e.id === target.entryId)
    if (!entry) return false
    const expectedProgram = autoVideoIdentity(state)
    autoVideoPending = expectedProgram
    void openFile(entry.filePath, { playlistId: entry.id, durationMs: entry.durationMs, startOnTake: true,
      transition: { id: randomUUID(), durationMs: target.fadeMs }, expectedProgram,
      autoPlayVideo: state.videoTakeMode !== 'hold-first' })
      .then(result => {
        if (!result.ok && autoVideoIdentity(store.get()) === expectedProgram)
          store.patchVideo(endVideo(store.get().video, false))
      })
      .finally(() => {
        if (autoVideoPending === expectedProgram) autoVideoPending = null
        videoBoundary.sync()
      })
    return true
  },
}
const videoBoundary = new VideoBoundaryScheduler(store, autoVideoAdvance)
videoBoundary.start()

/** Правка таймера в эфире становится длительностью именно этой записи. */
function persistProgramDuration(durationMs: number): void {
  const { currentPlaylistId, playlist } = store.get()
  if (!currentPlaylistId) return
  const entry = playlist.find((e) => e.id === currentPlaylistId)
  if (!entry || entry.durationMs === durationMs) return
  store.patch({ playlist: playlist.map((e) => e.id === currentPlaylistId ? { ...e, durationMs } : e) })
  persistPlaylist()
}

/**
 * Проверка материалов плейлиста на диске. Живые входы пропускаем — это не
 * файлы. Проверка идёт параллельно и не блокирует открытие проекта: на сетевой
 * шаре `access` может подтормаживать.
 * Возвращает число ненайденных, чтобы вызывающий показал баннер.
 */
export async function refreshMissingFiles(): Promise<number> {
  const playlist = store.get().playlist
  const missingPaths: string[] = []
  const checks = await Promise.all(
    playlist.map(async (e) => {
      if (e.kind === 'live' || isLiveUri(e.filePath)) return null
      // Список помечаем пропавшим, если нет хотя бы одного его материала:
      // дыра в пачке на сборе гостей так же заметна, как пропавший доклад.
      const paths = e.kind === 'list' ? (e.items ?? []).map((i) => i.path) : [e.filePath]
      if (paths.length === 0) return null
      let ok = true
      for (const path of paths) {
        try {
          await access(path)
        } catch {
          missingPaths.push(path)
          ok = false
        }
      }
      return ok ? null : e.id
    }),
  )
  const missingIds = checks.filter((id): id is string => id !== null)
  const before = store.get().missingIds
  // Патчим только при изменении — плейлист перерисовывается на каждый патч.
  if (before.length !== missingIds.length || missingIds.some((id, i) => before[i] !== id)) {
    store.patch({ missingIds, missingPaths })
  } else if (store.get().missingPaths.length !== missingPaths.length) {
    store.patch({ missingPaths })
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
  await waitForSessionRestore()
  const op = getOperatorWindow()
  const state = store.get()
  let target = state.projectPath
  if (!target || saveAs) {
    const res = await dialog.showSaveDialog(op!, {
      title: t('Сохранить проект'),
      defaultPath: target ?? `presenter-project.${PROJECT_EXTENSION}`,
      filters: [{ name: 'CueDeck project', extensions: [PROJECT_EXTENSION] }],
    })
    if (res.canceled || !res.filePath) return { ok: false }
    target = res.filePath
  }
  try {
    await saveProjectFile(target, {
      playlist: state.playlist,
      playlistFolders: state.playlistFolders,
      keyVisualPath: state.keyVisualPath,
      audienceTimer: audienceTimerConfig(state.audienceTimer),
      programOverlay: state.programOverlay,
    })
    store.patch({ projectPath: target })
    setProjectPath(target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function restoreLastSession(backupId?: string): Promise<OpenPdfResult & { hadSession: boolean }> {
  let saved: ReturnType<typeof beginSessionRestore>
  try { saved = beginSessionRestore(backupId) }
  catch (error) { return { ok: false, hadSession: false, error: error instanceof Error ? error.message : String(error) } }
  resetPreparation()
  let success = false
  try {
    stopListPlayback()
    const playlist = saved?.playlist ?? getPlaylist()
    const folders = saved?.playlistFolders ?? getPlaylistFolders()
    const id = saved ? saved.program.playlistId : getCurrentPlaylistId()
    const path = saved ? saved.program.path : getLastPdfPath()
    store.patch({ playlist: normalizeFolderPlaylist(playlist, folders), playlistFolders: folders,
      programOverlay: programOverlay(saved?.programOverlay),
      currentPlaylistId: id, keyVisualPath: saved ? saved.keyVisualPath : getKeyVisualPath(),
      projectPath: saved ? saved.projectPath : getProjectPath(), audienceTimer: createAudienceTimer(getAudienceTimer()) })
    void refreshMissingFiles()
    let result: OpenPdfResult
    if (saved) {
      result = await restoreSessionDecks(saved, {
        program: (filePath, playlistId) => openFile(filePath, { playlistId, restorePaused: true }),
        preview: (filePath, playlistId) => loadPreview(filePath, { playlistId }),
      })
    } else {
      clearSessionDecks()
      result = path ? await openFile(path, { playlistId: id, restorePaused: true }) : { ok: true }
    }
    if (!result.ok) return { ...result, hadSession: true }
    success = true
    if (path || playlist.length || folders.length) store.patch({ recoveryStartup: false })
    return { ...result, hadSession: Boolean(path || playlist.length || folders.length) }
  } finally {
    finishSessionRestore(success)
    if (success) preparationUi.background(store.get().playlist, store.get().projectPath)
    if (success && backupId) flushSessionCheckpoint()
  }
}

export function registerIpcHandlers(): void {
  void mobileClicker.setEnabled().catch(() => log.warn('mobile clicker: restore failed; saved link retained'))
  const requireOperator = (event: import('electron').IpcMainInvokeEvent): void => {
    if (event.sender !== getOperatorWindow()?.webContents || event.senderFrame !== getOperatorWindow()?.webContents.mainFrame)
      throw new Error('Operator window required')
  }
  onPreparationStatus((path, status) => preparationUi.phase(path, status))
  ipcMain.handle('playlist:prepare', async (event, id: unknown) => {
    const operator = getOperatorWindow()
    if (!operator || event.sender !== operator.webContents || event.senderFrame !== operator.webContents.mainFrame) throw new Error('Operator window required')
    if (typeof id !== 'string') return
    const entry = store.get().playlist.find(e => e.id === id && e.kind === 'pptx')
    if (!entry) return
    await preparationUi.prepare(entry.filePath, { priority: 'background', forceLocalCache: true, cacheProjectPath: store.get().projectPath })
  })
  initSessionLifecycle(async () => {
    const state = store.get()
    if (!state.projectPath) return
    await saveProjectFile(state.projectPath, { playlist: state.playlist, playlistFolders: state.playlistFolders,
      keyVisualPath: state.keyVisualPath, audienceTimer: audienceTimerConfig(state.audienceTimer), programOverlay: state.programOverlay })
  })
  ipcMain.handle('session:configure-startup', (event, raw: unknown) => {
    if (event.sender !== getOperatorWindow()?.webContents) throw new Error('Operator window required')
    return configureStartup(raw)
  })
  ipcMain.handle('session:startup', async (event) => {
    if (event.sender !== getOperatorWindow()?.webContents) throw new Error('Operator window required')
    if (!shouldRestoreAtStartup()) return { ok: true, hadSession: false, recovery: store.get().recoveryStartup }
    return { ...await restoreLastSession(), recovery: false }
  })
  setRecoveryStager(async plan => {
    if (isProjectTransferRunning()) throw new Error(t('Дождись окончания сборки проекта'))
    const folderId = randomUUID()
    const entries = plan.project.playlist.map(entry => ({ ...entry, id: randomUUID(), folderId }))
    if (plan.preview) {
      const entry = entries.find(item => item.filePath === plan.preview!.path)
      const result = await loadPreview(plan.preview.path, { playlistId: entry?.id ?? null })
      if (!result.ok) throw new Error(result.error ?? t('Не удалось открыть материалы отчёта'))
      const preview = store.get().preview
      store.patchPreview({
        recoveryTake: true,
        currentSlide: Math.max(1, Math.min(preview.totalSlides || 1, plan.preview.slide)),
        video: { ...preview.video, playing: false, muted: true, anchorSec: plan.preview.positionSec, anchorAt: null },
      })
    }
    if (entries.length) {
      const state = store.get()
      store.patch({
        playlist: [...state.playlist, ...entries],
        playlistFolders: [...state.playlistFolders, { id: folderId, name: t('Материалы отчёта') }],
      })
      persistPlaylist()
    }
  })
  ipcMain.handle('pdf:open-dialog', async () => {
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: t('Открыть PDF, PPTX, видео или изображение'),
      filters: openDialogFilters(),
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
    changeProgramSlide(clamped)
  })

  ipcMain.handle('nav:next', () => programNext())

  ipcMain.handle('nav:prev', () => programPrev())
  ipcMain.handle('clicker:next', () => clickerNavigation.next())
  ipcMain.handle('clicker:prev', () => clickerNavigation.prev())
  ipcMain.handle('mobile-clicker:reset', event => { requireOperator(event); return mobileClicker.resetLink() })
  ipcMain.handle('mobile-clicker:status', event => { requireOperator(event); return mobileClicker.status() })
  ipcMain.handle('mobile-clicker:qr', (event, index: number) => { requireOperator(event); return mobileClicker.qr(index) })
  ipcMain.handle('mobile-clicker:enabled', (event, enabled: boolean) => { requireOperator(event); return mobileClicker.setEnabled(enabled === true) })
  ipcMain.handle('program-overlay:set', (event, config: unknown) => {
    requireOperator(event)
    const overlay = programOverlay(config)
    if (overlay.mode === 'image' && overlay.path && kindOf(overlay.path) !== 'image') throw Error('Overlay supports images only')
    store.patch({ programOverlay: overlay })
  })
  ipcMain.handle('program-overlay:choose', async event => {
    requireOperator(event)
    const chosen = await dialog.showOpenDialog(getOperatorWindow()!, { title: t('Картинка для Overlay'), properties: ['openFile'],
      filters: [{ name: t('Изображения'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
    return chosen.canceled ? null : chosen.filePaths[0] ?? null
  })
  ipcMain.handle('program-overlay:read', async () => {
    const overlay = programOverlay(store.get().programOverlay)
    if (overlay.mode !== 'image' || !overlay.path || kindOf(overlay.path) !== 'image') return null
    const info = await stat(overlay.path)
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw Error(t('Картинка Overlay должна быть меньше 50 МБ'))
    return { bytes: await readFile(overlay.path), mime: mimeOf(overlay.path) }
  })

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
      title: t('Открыть в превью'),
      filters: openDialogFilters(),
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
    previewOpenGeneration++
    const path = store.get().preview.kind === 'video' ? store.get().preview.path : null
    store.patch({ preview: initialDeckState() })
    cancelFrameProbeIfUnused(path)
  })

  // Promote the staged preview deck onto the audience feed. Taking a playlist
  // entry applies its per-speaker timer; optional auto-start is limited to
  // presentation countdowns. Taking a loose file leaves the timer alone.
  // Video behaviour on take follows AppState.videoTakeMode.
  ipcMain.handle('preview:take', (_e, mode?: string) => {
    const state = store.get()
    const p = state.preview
    if (!p.path) return
    programOpenGeneration++
    previewOpenGeneration++
    const transition: TakeTransition = {
      id: randomUUID(),
      durationMs: mode === 'fade' ? sanitizeTakeFadeMs(state.takeFadeMs) : 0,
    }

    // В превью лежит первый элемент списка — в эфир уходит весь список,
    // с его циклом и таймингом фотографий.
    const previewList = p.playlistId
      ? state.playlist.find((e) => e.id === p.playlistId && e.kind === 'list')
      : undefined
    if (previewList) {
      store.patch({ previewListIndex: -1 })
      store.patchPreview(initialDeckState())
      void startListPlayback(previewList.id, transition)
      store.patchTimer({
        durationMs: previewList.durationMs,
        startedAt: null,
        elapsedMs: 0,
        running: false,
        cycles: 0,
      })
      return
    }

    const previewEntry = p.playlistId
      ? state.playlist.find((e) => e.id === p.playlistId)
      : undefined
    const recovery = recoveryTakeFrame(p, store.previewVideoPositionSec())
    const takeSlide = recovery?.slide ?? (
      (p.kind === 'pdf' || p.kind === 'pptx') && state.slideTakeMode === 'from-start'
        ? 1 : p.currentSlide)
    const sourceVideo = initialSlideVideo(p.kind, p.slideMedia, takeSlide, state.video.muted)
    const takeDuration = p.kind === 'video'
      ? (p.video.durationSec > 0
          ? p.video.durationSec
          : reusedVideoDuration(
              { path: state.pdfPath, sha1: state.pdfSha1, kind: state.fileKind, video: state.video },
              p.path, p.sha1, p.kind,
            ))
      : 0
    // New program video: mode picks In, resume position or hold-first. The
    // range is snapshotted into the program clock here; later In/Out edits on
    // this same entry apply immediately by id. PPTX uses its authored timing.
    let video: import('./state.js').VideoState
    if (recovery) {
      video = recovery.video
    } else if (p.kind === 'video') {
      video = planVideoTake({
        mode: state.videoTakeMode,
        previewPositionSec: store.previewVideoPositionSec(),
        durationSec: takeDuration,
        range: entryVideoRange(previewEntry, takeDuration),
        muted: state.video.muted,
      })
    } else {
      video = sourceVideo.video
    }

    // В эфире играл список — его проигрыватель останавливаем, иначе таймер фото
    // через несколько секунд открыл бы следующий элемент прямо в эфир поверх
    // только что выданного (двойной клик идёт через openFile — там остановка была).
    stopListPlayback()

    // Swap: whatever was on air goes back into preview (frozen, muted) so repeated
    // takes ping-pong the two decks. If program was empty, preview becomes empty.
    const oldProgramPos = store.videoPositionSec()
    const newPreview: DeckState = {
      sourceMuted: state.sourceMuted === true,
      recoveryTake: false,
      path: state.pdfPath,
      sha1: state.pdfSha1,
      kind: state.fileKind,
      totalSlides: state.totalSlides,
      currentSlide: state.currentSlide,
      notes: state.notes,
      playlistId: state.currentPlaylistId,
      slideMedia: state.slideMedia,
      slideTransitions: state.slideTransitions ?? {},
      slideBuilds: state.slideBuilds ?? {},
      video:
        state.fileKind === 'video'
          ? {
              playing: false,
              anchorSec: oldProgramPos,
              anchorAt: null,
              durationSec: state.video.durationSec,
              muted: true,
              range: state.video.range ?? null,
            }
          : { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: true },
    }

    // Слайдовые деки (Б-3): по режиму — с первого слайда (дефолт, оператор мог
    // полистать превью и забыть вернуть) или с текущего слайда превью.

    store.patch({
      takeTransition: transition,
      pdfPath: p.path,
      pdfSha1: p.sha1,
      fileKind: p.kind,
      sourceMuted: p.sourceMuted === true,
      totalSlides: p.totalSlides,
      currentSlide: takeSlide,
      notes: p.notes,
      currentPlaylistId: p.playlistId,
      slideMedia: p.slideMedia,
      slideTransitions: p.slideTransitions ?? {},
      slideBuilds: p.slideBuilds ?? {},
      video,
      // Цикл берём у выдаваемой записи: ролик-заставка должен уйти в эфир
      // зациклённым сразу, без второго действия оператора.
      videoLoop: recovery ? false : p.kind === 'pptx' ? sourceVideo.videoLoop : Boolean(previewEntry?.loop),
      preview: newPreview,
    })
    setLastPdfPath(p.path)
    setCurrentPlaylistId(p.playlistId)

    if (previewEntry && !recovery) {
      store.patchTimer(materialTakeTimer(previewEntry.durationMs, p.kind, state.timerMode, state.materialSettings.autoStartTimer, Date.now()))
      setLastDurationMs(previewEntry.durationMs)
    }
  })

  ipcMain.handle('preview:set-fade-ms', (_e, ms: unknown) => {
    const value = sanitizeTakeFadeMs(ms)
    store.patch({ takeFadeMs: value })
    setTakeFadeMs(value)
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
  ipcMain.handle('preview:toggle-source-muted', (event, identity: import('../shared/types.js').FrameStepIdentity) => {
    const operator = getOperatorWindow()
    if (!operator || operator.isDestroyed() || event.sender !== operator.webContents ||
      event.senderFrame !== operator.webContents.mainFrame) throw new Error('Operator window required')
    const patch = togglePreviewSourceMute(store.get(), identity)
    if (!patch) return
    store.patch(patch)
    if (patch.playlist) persistPlaylist()
  })

  // Preview monitoring stays independent of the input's program mute.
  ipcMain.handle('preview:video:pause', () => {
    if (!store.get().preview.video.playing) return
    store.patchPreviewVideo({ playing: false, anchorSec: store.previewVideoPositionSec(), anchorAt: null })
  })
  ipcMain.handle('preview:video:toggle', () => {
    const v = store.get().preview.video
    if (v.playing) {
      store.patchPreviewVideo({ playing: false, anchorSec: store.previewVideoPositionSec(), anchorAt: null })
    } else {
      store.patchPreviewVideo(playVideoFrom(v, store.previewVideoPositionSec()))
    }
  })

  ipcMain.handle('preview:video:seek', (_e, sec: number) => {
    const v = store.get().preview.video
    store.patchPreviewVideo(seekVideoTo(v, Number.isFinite(sec) ? sec : 0))
  })

  ipcMain.handle('preview:video:seek-by', (_e, deltaSec: number) => {
    const v = store.get().preview.video
    const delta = Number.isFinite(deltaSec) ? deltaSec : 0
    store.patchPreviewVideo(seekVideoTo(v, store.previewVideoPositionSec() + delta))
  })

  ipcMain.handle('preview:video:set-duration', (_e, sec: number) => {
    if (!Number.isFinite(sec) || sec <= 0) return
    const v = store.get().preview.video
    if (v.durationSec === sec) return
    const range = normalizeVideoRange(v.range, sec)
    const currentPosition = store.previewVideoPositionSec()
    const position = clampVideoPosition(currentPosition, range, sec)
    const patch: Partial<import('./state.js').VideoState> = { durationSec: sec, range }
    if (position !== currentPosition) {
      patch.anchorSec = position
      patch.anchorAt = v.playing ? Date.now() : null
    }
    store.patchPreviewVideo(patch)
  })

  ipcMain.handle('preview:video:ended', () => {
    const state = store.get()
    const v = state.preview.video
    const bounds = normalizeVideoRange(v.range, v.durationSec)
    if (bounds && (!v.playing || store.previewVideoPositionSec() < bounds.outSec - 1e-6)) return
    // Превью показывает то же поведение, что будет в эфире: зациклённая запись
    // и в превью крутится по кругу — иначе значок включён, а ролик встал.
    const entry = state.preview.playlistId
      ? state.playlist.find((e) => e.id === state.preview.playlistId)
      : undefined
    store.patchPreviewVideo(endVideo(v, Boolean(entry?.loop)))
  })

  ipcMain.handle('note:update', (_e, payload: { slide: number; text: string }) => {
    const { slide, text } = payload
    store.patchNotes(slide, text)
    const { pdfPath, pdfSha1, notes } = store.get()
    if (pdfPath && pdfSha1) notesWriter.schedule(pptxNotesPathBySha1.get(pdfSha1) ?? pdfPath, pdfSha1, ownNotes(pdfSha1, notes))
  })

  const audienceTimer = createAudienceTimerCommands(store, setAudienceTimer)
  setInterval(() => audienceTimer.tick(), 100)
  for (const action of ['start', 'pause', 'reset'] as const) {
    ipcMain.handle(`audience-timer:${action}`, () => {
      audienceTimer.action(action)
    })
  }
  ipcMain.handle('audience-timer:adjust', (_e, deltaMs: unknown) => audienceTimer.adjust(deltaMs))
  ipcMain.handle('audience-timer:visible', (_e, visible: unknown) => audienceTimer.setVisible(visible))
  ipcMain.handle('audience-timer:configure', (_e, config: unknown) => audienceTimer.configure(config))

  ipcMain.handle('timer:start', () => {
    const t = store.get().timer
    if (t.running) return
    store.patchTimer({ startedAt: Date.now(), running: true })
  })

  ipcMain.handle('materials:configure', (_e, value: unknown) => {
    const candidate = value as { defaultDurationMs?: unknown; autoStartTimer?: unknown } | null
    if (!validMaterialDuration(candidate?.defaultDurationMs) || typeof candidate?.autoStartTimer !== 'boolean') throw new Error('Invalid material settings')
    const materialSettings = sanitizeMaterialSettings(candidate)
    setMaterialSettings(materialSettings)
    store.patch({ materialSettings })
  })
  ipcMain.handle('materials:set-durations', (_e, ids: unknown, durationMs: unknown) => {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string') || !validMaterialDuration(durationMs)) throw new Error('Invalid duration selection')
    const selected = new Set(ids)
    // Preparation affects cards only; never alter the running program timer.
    store.patch({ playlist: store.get().playlist.map(entry => selected.has(entry.id) ? { ...entry, durationMs } : entry) })
    persistPlaylist()
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
    persistProgramDuration(clamped)
  })

  ipcMain.handle('timer:adjust', (_e, deltaMs: number) => {
    const st = store.get()
    const patch = adjustPatch(st.timer, st.timerMode, deltaMs)
    if (!patch) return
    store.patchTimer(patch)
    // В секундомере длительность не менялась — «последнюю длительность» не трогаем.
    if (patch.durationMs !== undefined) {
      setLastDurationMs(patch.durationMs)
      persistProgramDuration(patch.durationMs)
    }
  })

  ipcMain.handle('timer:set-mode', (_e, mode: TimerMode) => {
    store.patch({ timerMode: mode })
    setTimerMode(mode)
  })

  ipcMain.handle('timer:reset-style', event => {
    requireOperator(event)
    const style = defaultSpeakerTimerStyle()
    setTimerPosition(style.timerPosition)
    setTimerScale(style.timerScale)
    setTimerFree(style.timerFree)
    setTimerFont(style.timerFont)
    setTimerColor(style.timerColor)
    setTimerWarnColors(style.timerWarnColors)
    store.patch(style)
  })

  ipcMain.handle('timer:set-position', (_e, pos: TimerPosition) => {
    store.patch({ timerPosition: pos })
    setTimerPosition(pos)
  })

  // Свободное положение таймера на суфлёре: центр в долях экрана (0..1).
  ipcMain.handle('timer:set-free', (_e, x: number, y: number) => {
    const c = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)
    const pos = { x: Math.round(c(x) * 1_000_000) / 1_000_000, y: Math.round(c(y) * 1_000_000) / 1_000_000 }
    store.patch({ timerFree: pos, timerPosition: 'free' })
    setTimerFree(pos)
    setTimerPosition('free')
  })

  // Цвет цифр таймера на суфлёре: '#rrggbb' или null (стандартный зелёный).
  ipcMain.handle('timer:set-font', (_e, value: unknown) => {
    const font = timerFont(value)
    store.patch({ timerFont: font })
    setTimerFont(font)
  })
  ipcMain.handle('timer:set-color', (_e, color: unknown) => {
    const c = validTimerColor(color)
    store.patch({ timerColor: c })
    setTimerColor(c)
  })
  ipcMain.handle('timer:set-warn-colors', (_e, v: unknown) => {
    const on = v !== false
    store.patch({ timerWarnColors: on })
    setTimerWarnColors(on)
  })
  // Колонки суфлёра — с макета в настройках или сплиттерами на самом суфлёре.
  ipcMain.handle('prompter:set-toolbar-scale', (_e, value: unknown) => {
    const scale = sanitizeSpeakerToolbarScale(value)
    store.patch({ speakerToolbarScale: scale })
    setSpeakerToolbarScale(scale)
  })
  ipcMain.handle('prompter:set-layout', (_e, v: unknown) => {
    const layout = sanitizeSpeakerLayout(v)
    store.patch({ speakerLayout: layout })
    setSpeakerLayout(layout)
  })
  // Сообщение спикеру: положение (null — сверху по центру) и масштаб.
  ipcMain.handle('speaker-message:set-layout', (_e, v: unknown) => {
    const layout = sanitizeSpeakerMsgLayout(v)
    store.patch({ speakerMsgLayout: layout })
    setSpeakerMsgLayout(layout)
  })

  // Масштаб 0.3–4: суфлёры бывают от 7" до 85" — старый потолок 2.5 не хватал.
  ipcMain.handle('timer:set-scale', (_e, scale: number) => {
    const clamped = Math.max(0.3, Math.min(4, Math.round(scale * 100) / 100))
    store.patch({ timerScale: clamped })
    setTimerScale(clamped)
  })

  ipcMain.handle('timer:set-tick-sound', (_e, enabled: boolean) => {
    const v = Boolean(enabled)
    audienceTimer.configure({ tickEnabled: v })
    setTimerTickEnabled(v)
  })

  ipcMain.handle('timer:set-gong-sound', (_e, enabled: boolean) => {
    const v = Boolean(enabled)
    audienceTimer.configure({ gongEnabled: v })
    setTimerGongEnabled(v)
  })

  ipcMain.handle('timer:set-loop', (_e, enabled: boolean) => {
    const v = Boolean(enabled)
    audienceTimer.configure({ loop: v })
    setTimerLoop(v)
  })

  // Minutes of the four preset buttons are user-editable (ПКМ по кнопке);
  // invalid/empty slots fall back to the defaults slot by slot.
  ipcMain.handle('timer:set-adjustments', (_e, values: unknown) => {
    const clean = timerAdjustments(values)
    store.patch({ timerAdjustments: clean })
    setTimerAdjustments(clean)
  })

  ipcMain.handle('timer:set-presets', (_e, presets: number[]) => {
    const arr = Array.isArray(presets) ? presets : []
    const clean = DEFAULT_TIMER_PRESETS.map((def, i) => {
      const v = Math.floor(Number(arr[i]))
      return Number.isFinite(v) && v >= 1 && v <= 999 ? v : def
    })
    store.patch({ timerPresets: clean })
    setTimerPresets(clean)
  })

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
      return v || t(def)
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
    store.patchVideo(playVideoFrom(v, store.videoPositionSec()))
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
      store.patchVideo(playVideoFrom(v, store.videoPositionSec()))
    }
  })

  ipcMain.handle('video:seek', (_e, sec: number) => {
    const v = store.get().video
    store.patchVideo(seekVideoTo(v, Number.isFinite(sec) ? sec : 0))
  })

  ipcMain.handle('video:seek-by', (_e, deltaSec: number) => programSeekBy(deltaSec))

  ipcMain.handle('video:set-duration', (_e, sec: number) => {
    if (!Number.isFinite(sec) || sec <= 0) return
    const v = store.get().video
    if (v.durationSec === sec) return
    const range = normalizeVideoRange(v.range, sec)
    const currentPosition = store.videoPositionSec()
    const position = clampVideoPosition(currentPosition, range, sec)
    const patch: Partial<import('./state.js').VideoState> = { durationSec: sec, range }
    if (position !== currentPosition) {
      patch.anchorSec = position
      patch.anchorAt = v.playing ? Date.now() : null
    }
    store.patchVideo(patch)
  })

  // Real EOF from the operator (the main Out deadline uses endVideo directly).
  // Loop wraps to In; otherwise freeze on Out, not on the file duration.
  ipcMain.handle('video:ended', () => {
    if (autoVideoPending && autoVideoIdentity(store.get()) === autoVideoPending) return
    if (autoVideoTarget(store.get()) && autoVideoAdvance.run(store.get())) return
    if (isListPlaying()) {
      void stepList(1)
      return
    }
    const v = store.get().video
    const bounds = normalizeVideoRange(v.range, v.durationSec)
    // Ignore a duplicate/stale native ended that arrives after the deadline has
    // already paused at Out or wrapped to In.
    if (bounds && (!v.playing || store.videoPositionSec() < bounds.outSec - 1e-6)) return
    store.patchVideo(endVideo(v, store.get().videoLoop))
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
    if (value && !v.playing && v.durationSec > 0 &&
        store.videoPositionSec() >= videoRangeEnd(v.range, v.durationSec) - 0.05) {
      store.patchVideo({
        playing: true,
        anchorSec: videoRangeStart(v.range, v.durationSec),
        anchorAt: Date.now(),
      })
    }
  })

  ipcMain.handle('video:set-muted', (_e, muted: boolean) => {
    store.patchVideo({ muted: Boolean(muted) })
  })

  ipcMain.handle('video:toggle-muted', () => {
    store.patchVideo({ muted: !store.get().video.muted })
  })

  registerVideoInOutIpc(ipcMain, videoInOut)

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

  ipcMain.handle('layout:set', (_e, payload: { layout: Layout; displayMap: DisplayMap; audienceWindowed?: boolean; audienceAlwaysOnTop?: boolean }) => {
    const windowed = Boolean(payload.audienceWindowed)
    const alwaysOnTop = typeof payload.audienceAlwaysOnTop === 'boolean' ? payload.audienceAlwaysOnTop : store.get().audienceAlwaysOnTop
    applyLayout(payload.layout, payload.displayMap, windowed, alwaysOnTop)
    saveMapping(store.get().layout, store.get().displayMap)
    setAudienceWindowed(windowed)
    setAudienceAlwaysOnTop(alwaysOnTop)
  })

  ipcMain.handle('layout:get-ask-on-startup', () => getAskLayoutOnStartup())

  ipcMain.handle('layout:set-ask-on-startup', (_e, value: boolean) => {
    setAskLayoutOnStartup(Boolean(value))
  })

  // Мониторы выходов под эфиром (живые снимки окон суфлёра/зала)
  ipcMain.handle('monitor:audience-size', (event) => {
    if (event.sender !== getOperatorWindow()?.webContents) return { width: 1920, height: 1080 }
    const win = getActiveWindows().get('audience') ?? ghostWindow('audience')
    if (win && !win.isDestroyed()) {
      const [width, height] = win.getContentSize()
      return { width, height }
    }
    const display = screen.getAllDisplays().find(d => d.id === store.get().displayMap.audience)
    return { width: display?.size.width ?? 1920, height: display?.size.height ?? 1080 }
  })
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

  // Язык интерфейса: запоминаем, применится после перезапуска (i18n.ts).
  // Отдаём выбранный, а не текущий: выбрали и не перезапустили — галка
  // в «Настройках» должна стоять на выбранном.
  ipcMain.handle('ui:get-lang', () => getUiLang() ?? getLang())
  ipcMain.handle('ui:set-lang', (_e, lang: unknown) => {
    const v = parseLang(lang)
    if (v) setUiLang(v)
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
    if (photos) parts.push(t('{n} фото', { n: photos }))
    if (videos) parts.push(t('{n} видео', { n: videos }))
    return t('Список — {what}', { what: parts.join(', ') || t('пусто') })
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
      durationMs: store.get().materialSettings.defaultDurationMs,
      items,
      photoSec: DEFAULT_PHOTO_SEC,
      // Списки заводят ради «крутится по кругу» — цикл по умолчанию включён.
      loop: true,
    }
    store.patch({ playlist: [...store.get().playlist, entry] })
    persistPlaylist()
    return [entry]
  }

  function appendToPlaylist(paths: string[], position?: PlaylistInsertPosition): PlaylistEntry[] {
    const existing = store.get().playlist
    const defaultDur = store.get().materialSettings.defaultDurationMs
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
      const playlist = insertPlaylistEntries(existing, newEntries, store.get().playlistFolders, position)
      store.patch({ playlist })
      persistPlaylist()
      preparationUi.background(newEntries, store.get().projectPath)
      void refreshMissingFiles()
      const addedIds = new Set(newEntries.map((entry) => entry.id))
      return playlist.filter((entry) => addedIds.has(entry.id))
    }
    return newEntries
  }

  ipcMain.handle('playlist:add', async (): Promise<PlaylistEntry[]> => {
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: t('Добавить файлы в плейлист'),
      filters: openDialogFilters(),
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
      title: t('Файлы для списка'),
      message: t('Фотографии и ролики, которые пойдут по кругу'),
      filters: [
        { name: t('Фото и видео'), extensions: [...IMAGE_EXTS_ARR, ...VIDEO_EXTS_ARR] },
        { name: t('Изображения'), extensions: IMAGE_EXTS_ARR },
        { name: t('Видео'), extensions: VIDEO_EXTS_ARR },
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

  /**
   * Заменить один материал списка: фотография переехала — меняем путь у
   * элемента, не трогая порядок и остальную пачку.
   */
  ipcMain.handle(
    'playlist:relocate-item',
    async (_e, payload: { id: string; index: number }): Promise<boolean> => {
      const entry = store.get().playlist.find((x) => x.id === payload.id)
      if (!entry || entry.kind !== 'list') return false
      const items = [...(entry.items ?? [])]
      const old = items[payload.index]
      if (!old) return false
      const op = getOperatorWindow()
      const res = await dialog.showOpenDialog(op!, {
        title: t('Указать файл вместо «{name}»', { name: old.fileName }),
        filters: [{ name: t('Фото и видео'), extensions: [...IMAGE_EXTS_ARR, ...VIDEO_EXTS_ARR] }],
        properties: ['openFile'],
      })
      if (res.canceled || res.filePaths.length === 0) return false
      const picked = res.filePaths[0]
      const kind = kindOf(picked)
      if (kind !== 'image' && kind !== 'video') return false
      items[payload.index] = { path: picked, fileName: basename(picked), kind }
      store.patch({
        playlist: store.get().playlist.map((x) => (x.id === payload.id ? { ...x, items } : x)),
      })
      persistPlaylist()
      await refreshMissingFiles()
      return true
    },
  )

  /** Добавить файлы в существующий список. */
  ipcMain.handle('playlist:add-to-list', async (_e, id: string): Promise<boolean> => {
    const entry = store.get().playlist.find((x) => x.id === id)
    if (!entry || entry.kind !== 'list') return false
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: t('Добавить в список'),
      filters: [{ name: t('Фото и видео'), extensions: [...IMAGE_EXTS_ARR, ...VIDEO_EXTS_ARR] }],
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
      makeLiveUri(src),
    ])
  })

  // Drag & drop из Finder/Explorer: пути приходят из рендерера (webUtils).
  ipcMain.handle('playlist:add-paths', (_e, paths: string[], position?: PlaylistInsertPosition): PlaylistEntry[] => {
    if (!Array.isArray(paths)) return []
    return appendToPlaylist(paths, position && typeof position === 'object' ? position : undefined)
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
    const uri = makeLiveUri(payload.src)
    if (uri === oldPath) return

    const state = store.get()
    const patch: Partial<import('./state.js').AppState> = {
      playlist: state.playlist.map((e) =>
        e.id === payload.id ? { ...e, filePath: uri, fileName: liveDisplayName(uri) } : e,
      ),
    }
    if (state.pdfPath === oldPath) {
      patch.pdfPath = uri
      patch.pdfSha1 = uri
    }
    if (state.preview.path === oldPath) {
      patch.preview = { ...state.preview, path: uri, sha1: uri }
    }
    // All consumers must switch together, or the operator opens both URIs.
    store.patch(patch)
    persistPlaylist()
    if (state.pdfPath === oldPath) setLastPdfPath(uri)

  })

  ipcMain.handle('playlist:folder-create', (_e, name: string) => {
    if (typeof name !== 'string') throw new Error('Invalid folder name')
    const folderName = name.trim() || nextPlaylistFolderName(store.get().playlistFolders)
    const id = randomUUID()
    store.patch({ playlistFolders: [...store.get().playlistFolders, { id, name: folderName }] })
    persistPlaylist()
    return id
  })
  ipcMain.handle('playlist:folder-rename', (_e, { id, name }: { id: string; name: string }) => {
    if (typeof name !== 'string' || !name.trim()) return
    store.patch({ playlistFolders: store.get().playlistFolders.map((f) => f.id === id ? { ...f, name: name.trim() } : f) })
    persistPlaylist()
  })
  ipcMain.handle('playlist:folder-remove', (_e, payload: { id: string; removeContents?: boolean }) => {
    const state = store.get()
    const result = removePlaylistFolder(state.playlist, state.playlistFolders, payload.id, payload.removeContents === true)
    removePlaylistEntries(result.playlist, result.removed, { playlistFolders: result.playlistFolders })
  })
  function assignFolderEntries(ids: string[], folderId: string | null): void {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return
    const state = store.get()
    const playlist = assignPlaylistFolders(state.playlist, state.playlistFolders, ids, folderId)
    if (playlist === state.playlist) return
    store.patch({ playlist })
    persistPlaylist()
  }
  ipcMain.handle('playlist:folder-assign', (_e, { id, folderId }: { id: string; folderId: string | null }) => assignFolderEntries([id], folderId))
  ipcMain.handle('playlist:folders-assign', (_e, { ids, folderId }: { ids: string[]; folderId: string | null }) => assignFolderEntries(ids, folderId))
  ipcMain.handle('playlist:folder-collapse', (_e, { id, collapsed }: { id: string; collapsed: boolean }) => {
    store.patch({ playlistFolders: store.get().playlistFolders.map((f) => f.id === id ? { ...f, collapsed: Boolean(collapsed) } : f) })
    persistPlaylist()
  })

  function removePlaylistEntries(next: PlaylistEntry[], removed: PlaylistEntry[], extra: Partial<import('./state.js').AppState> = {}): void {
    const state = store.get()
    const removedIds = new Set(removed.map((entry) => entry.id))
    const patch: Partial<import('./state.js').AppState> = { ...extra, playlist: next }
    for (const path of new Set(removed.filter(e => e.kind === 'pptx').map(e => e.filePath))) {
      if (!next.some(e => e.filePath === path) && state.pdfPath !== path && state.preview.path !== path) {
        preparationUi.forget(path)
        cancelPresentationPreparation(path)
      }
    }
    if (state.currentPlaylistId && removedIds.has(state.currentPlaylistId)) {
      if (removed.some((entry) => entry.id === state.currentPlaylistId && entry.kind === 'list')) stopListPlayback()
      patch.currentPlaylistId = null
      setCurrentPlaylistId(null)
    }
    // Release removed live previews; the program feed keeps playing its current material.
    if (removed.some((entry) => entry.kind === 'live' && state.preview.path === entry.filePath)) {
      patch.preview = initialDeckState()
    }
    store.patch(patch)
    persistPlaylist()
    if (state.missingIds.some((id) => removedIds.has(id))) void refreshMissingFiles()
  }

  ipcMain.handle('playlist:remove', (_e, id: string) => {
    const playlist = store.get().playlist
    removePlaylistEntries(playlist.filter((entry) => entry.id !== id), playlist.filter((entry) => entry.id === id))
  })

  ipcMain.handle('playlist:duplicate', (_e, id: string): PlaylistEntry | null => {
    const state = store.get()
    const newId = randomUUID()
    const playlist = duplicatePlaylistEntry(state.playlist, id, newId)
    if (playlist === state.playlist) return null
    store.patch({ playlist })
    persistPlaylist()
    void refreshMissingFiles()
    return playlist.find((entry) => entry.id === newId) ?? null
  })

  ipcMain.handle('playlist:reorder', (_e, ids: string[]) => {
    const state = store.get()
    store.patch({ playlist: reorderFolderPlaylist(state.playlist, ids, state.playlistFolders) })
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
        slideFadeMs?: number
        slideFadeMode?: 'file' | 'custom' | 'cut'
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
              ...(typeof payload.slideFadeMs === 'number' && (e.kind === 'pdf' || e.kind === 'pptx')
                ? { slideFadeMs: sanitizeSlideFadeMs(payload.slideFadeMs) } : {}),
              ...(['file', 'custom', 'cut'].includes(payload.slideFadeMode ?? '') && (e.kind === 'pdf' || e.kind === 'pptx')
                ? { slideFadeMode: payload.slideFadeMode } : {}),
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
      if (!first) return { ok: false, error: t('Список пуст — добавь фото или ролики') }
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
        return { ok: false, error: t('Список пуст — добавь фото или ролики') }
      }
      await startListPlayback(id)
      return { ok: true, path: entry.items[0].path }
    }
    return openFile(entry.filePath, { playlistId: id, durationMs: entry.durationMs, startOnTake: true })
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
      title: t('Выбрать заставку (key visual)'),
      filters: [
        { name: t('Картинка или видео'), extensions: [...IMAGE_EXTS_ARR, 'gif', ...VIDEO_EXTS_ARR] },
        { name: t('Изображения'), extensions: [...IMAGE_EXTS_ARR, 'gif'] },
        { name: t('Видео'), extensions: VIDEO_EXTS_ARR },
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

  ipcMain.handle('pptx:read-animation', async (_event, file: unknown, sha: unknown) => {
    const state=store.get()
    if(typeof file!=='string' || typeof sha!=='string' || sha!==state.pdfSha1 || /[/\\\0]/.test(file) || !file.endsWith('.pdf') ||
      !Object.values(state.slideBuilds??{}).some(build=>build.framesFile===file)) return null
    const path=join(mediaDirFor(sha),file), info=await stat(path).catch(()=>null)
    if(!info?.isFile() || info.size>24*1024*1024) return null
    return new Uint8Array(await readFile(path))
  })
  ipcMain.handle('pptx:backend', () => getPptxBackend())
  ipcMain.handle('pptx:set-backend', (_event, backend: unknown) => {
    if (backend !== 'libreoffice' && backend !== 'powerpoint-static') throw new Error('Invalid PPTX backend')
    if (backend === 'powerpoint-static' && process.platform !== 'darwin') throw new Error('PowerPoint static mode is Mac only')
    setPptxBackend(backend)
  })
  ipcMain.handle('soffice:check', async () => {
    return Boolean(await findSoffice())
  })

  const activePptxHashes = (): Set<string> => {
    const state = store.get()
    const hashes = new Set<string>()
    if (state.fileKind === 'pptx' && state.pdfSha1) hashes.add(state.pdfSha1)
    if (state.preview.kind === 'pptx' && state.preview.sha1) hashes.add(state.preview.sha1)
    return hashes
  }

  ipcMain.handle('pptx-cache:stats', () => runPptxWork(() => localCacheStats(activePptxHashes())))
  ipcMain.handle('pptx-cache:open-folder', async () => {
    try {
      const path = localPptxCacheDir()
      await mkdir(path, { recursive: true })
      const error = await shell.openPath(path)
      return error ? { ok: false, error } : { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('pptx-cache:clear', async () => {
    const preparing = (): boolean => pendingDeckLoads > 0 || Object.values(store.get().preparations).some(s => s.phase === 'queued' || s.phase === 'preparing')
    if (preparing()) return { ok: false, error: t('Дождись окончания подготовки презентаций перед очисткой кэша') }
    if (isProjectTransferRunning()) return { ok: false, error: t('Дождись окончания сборки проекта перед очисткой кэша') }
    const stats = await runPptxWork(() => localCacheStats(activePptxHashes()))
    if (stats.bytes === stats.protectedBytes) return { ok: true, clearedBytes: 0, remainingBytes: stats.protectedBytes }
    const { response } = await dialog.showMessageBox(getOperatorWindow()!, {
      type: 'warning',
      buttons: [t('Отмена'), t('Очистить кэш')],
      defaultId: 0,
      cancelId: 0,
      message: t('Очистить локальный кэш презентаций?'),
      detail: t('Удалённые PPTX при следующем выборе конвертируются заново. Открытые сейчас презентации и кэш собранных проектов останутся.'),
    })
    if (response !== 1) return { ok: false, cancelled: true }
    if (preparing()) return { ok: false, error: t('Дождись окончания подготовки презентаций перед очисткой кэша') }
    try {
      const cleared = await runPptxWork(() => clearLocalCache(activePptxHashes()))
      preparationUi.reset()
      return { ok: true, clearedBytes: cleared.bytes, remainingBytes: cleared.protectedBytes }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /**
   * «Шрифты поставил — пересобрать»: сбросить PDF этого PPTX из кэша и
   * конвертировать заново. Открытый сейчас слайд не трогаем: новый PDF
   * подхватится, когда спикера выберут снова.
   */
  ipcMain.handle('pptx:rebuild', async (_e, filePath: string) => {
    try {
      if (isProjectTransferRunning()) return { ok: false, error: t('Дождись окончания сборки проекта перед пересборкой презентации') }
      if (kindOf(filePath) !== 'pptx') return { ok: false, error: t('Это не PPTX') }
      // Rebuild into a new generation. Open decks keep their old files intact.
      await inspectFile(filePath, { forceLocalCache: true })
      return { ok: true, remaining: store.get().fontIssues[filePath] ?? [] }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /**
   * Шрифты, которые принесли с презентацией: копируем в папку шрифтов
   * пользователя (мак — ~/Library/Fonts, Windows — %LOCALAPPDATA%\Microsoft\
   * Windows\Fonts + регистрация) — LibreOffice берёт шрифты лишь у системы.
   * Список добавленного ведём, чтобы «Убрать» стирало ровно это.
   */
  const fontsDir = (): string | null => {
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Fonts')
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      return join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')
    }
    return null
  }
  const fontHooks: FontHooks =
    process.platform === 'win32' ? { install: installWinFont, uninstall: uninstallWinFont } : {}
  const fontsList = (): string => join(app.getPath('userData'), 'added-fonts.json')

  ipcMain.handle('fonts:info', async () => ({
    supported: fontsDir() !== null,
    added: await addedFontsCount(fontsList()),
  }))

  ipcMain.handle('fonts:add', async () => {
    const dir = fontsDir()
    if (!dir) return { ok: false, error: t('Здесь добавить шрифты нельзя: только macOS и Windows') }
    const res = await dialog.showOpenDialog(getOperatorWindow()!, {
      title: t('Выбери папку со шрифтами или сами файлы'),
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: t('Шрифты'), extensions: ['ttf', 'otf', 'ttc', 'otc'] }],
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, cancelled: true }
    try {
      const out = await addFonts(res.filePaths, dir, fontsList(), fontHooks)
      log.info(`[fonts] добавлено ${out.added.length}, уже были ${out.skipped.length}, не приняты ${out.failed.join(', ') || '—'}`) // i18n-ok
      return {
        ok: true,
        added: out.added.length - out.failed.length,
        skipped: out.skipped.length,
        failed: out.failed,
        found: out.added.length + out.skipped.length,
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('fonts:remove', async () => {
    const dir = fontsDir()
    if (!dir) return { ok: false, error: t('Здесь добавить шрифты нельзя: только macOS и Windows') }
    try {
      const removed = await removeAddedFonts(dir, fontsList(), fontHooks)
      log.info(`[fonts] убрано ${removed}`) // i18n-ok
      return { ok: true, removed }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** Какой soffice сейчас используется — для раздела «Настройки → PPTX / LibreOffice». */
  ipcMain.handle('soffice:current', async () => (await findSoffice()) ?? null)

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
      title: t('Укажи, где установлен LibreOffice'),
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
    return hasLastSession() || Boolean(getLastPdfPath()) || getPlaylist().length > 0 || getPlaylistFolders().length > 0
  })

  /** Restores the last session: playlist, key visual, project path, and last open file. */
  ipcMain.handle('session:restore', () => restoreLastSession())
  ipcMain.handle('session:restore-backup', async event => {
    if (event.sender !== getOperatorWindow()?.webContents) throw new Error('Operator window required')
    try {
      const backups = listSessionBackups()
      if (!backups.length) return { ok: false, error: t('Контрольных копий пока нет') }
      const result = await dialog.showMessageBox(getOperatorWindow()!, {
        type: 'question', title: t('Контрольные копии'),
        message: t('Выбери копию для восстановления'),
        buttons: [...backups.map(item => item.name), t('Отмена')],
        cancelId: backups.length, defaultId: backups.length, noLink: true,
      })
      if (result.response === backups.length) return { ok: false, cancelled: true }
      return await restoreLastSession(backups[result.response].id)
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  ipcMain.handle('project:new', () => {
    resetPreparation()
    beginEmptyProject()
    stopListPlayback()
    // Intentionally do NOT clear persistent storage (lastPdfPath, playlist,
    // keyVisualPath, projectPath) — this keeps session:has-last returning true
    // so the user can restore the previous session via "Последний" after reset.
    store.patch({
      playlist: [],
      playlistFolders: [],
      programOverlay: programOverlay(null),
      currentPlaylistId: null,
      keyVisualPath: null,
      projectPath: null,
      pdfPath: null,
      sourceMuted: false,
      pdfSha1: null,
      fileKind: null,
      totalSlides: 0,
      currentSlide: 1,
      notes: {},
      slideMedia: [],
      blackout: false,
      preview: initialDeckState(),
      speakerMessage: null,
      audienceTimer: createAudienceTimer(getAudienceTimer()),
    })
    finishEmptyProject()
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
      try { assertSessionIdle() }
      catch (error) { return { ok: false, error: (error as Error).message } }
      const op = getOperatorWindow()
      const res = await dialog.showOpenDialog(op!, {
        title: t('Открыть проект'),
        filters: [{ name: 'CueDeck project', extensions: [PROJECT_EXTENSION] }],
        properties: ['openFile'],
      })
      if (res.canceled || res.filePaths.length === 0) return { ok: false }
      const path = res.filePaths[0]
      try {
        assertSessionIdle()
        if (store.get().testScreen.automatic) store.patch({ testScreen: { ...store.get().testScreen, automatic: false } })
        const loaded = await loadProjectFile(path)
        resetPreparation()
        beginEmptyProject()
        store.patch({
          playlist: loaded.playlist,
          playlistFolders: loaded.playlistFolders,
          keyVisualPath: loaded.keyVisualPath,
          programOverlay: programOverlay(loaded.programOverlay),
          audienceTimer: createAudienceTimer(loaded.audienceTimer ?? getAudienceTimer()),
          currentPlaylistId: null,
          projectPath: path,
          pdfPath: null,
          pdfSha1: null,
          fileKind: null,
          sourceMuted: false,
          totalSlides: 0,
          currentSlide: 1,
          notes: {},
          slideMedia: [],
          preview: initialDeckState(),
        })
        persistPlaylist()
        preparationUi.background(loaded.playlist, path)
        setKeyVisualPath(loaded.keyVisualPath)
        if (loaded.audienceTimer) setAudienceTimer(loaded.audienceTimer)
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
        title: t('Где теперь лежат материалы?'),
        message: t('Выбери папку — файлы найдутся в ней и во вложенных папках по именам'),
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

  ipcMain.handle('project:reveal-transfer', () => {
    const status = store.get().projectTransfer
    if (status?.phase === 'done' && status.path) shell.showItemInFolder(status.path)
  })

  ipcMain.handle('project:consolidate', async () => {
    if (!beginProjectTransfer()) return { ok: false, error: t('Сборка проекта уже идёт') }
    const snapshot = structuredClone(store.get())
    const progress = (projectTransfer: ProjectTransferStatus | null): void => { store.patch({ projectTransfer }) }
    progress({ phase: 'choosing', completed: 0, total: 0, file: '' })
    try {
      if (!snapshot.playlist.length && !snapshot.keyVisualPath) throw new Error(t('Проект пуст — нечего собирать'))
      const res = await dialog.showOpenDialog(getOperatorWindow()!, {
        title: t('Куда собрать проект'),
        message: t('Выбери папку — внутри появится папка проекта со всеми материалами'),
        properties: ['openDirectory', 'createDirectory'],
      })
      if (res.canceled || !res.filePaths.length) {
        progress(null)
        return { ok: false, cancelled: true }
      }
      await flushPendingWrites()
      const name = snapshot.projectPath ? basename(snapshot.projectPath, `.${PROJECT_EXTENSION}`) : t('CueDeck-проект')
      const result = await transferProject({
        parent: res.filePaths[0], name,
        playlist: snapshot.playlist, playlistFolders: snapshot.playlistFolders, keyVisualPath: snapshot.keyVisualPath,
        audienceTimer: audienceTimerConfig(snapshot.audienceTimer),
        programOverlay: snapshot.programOverlay,
        progress,
        prepare: async (source, target, directory) => {
          if (kindOf(source) !== 'pptx') return []
          const info = await inspectFile(target, {
            cacheSourcePath: source, cacheProjectPath: snapshot.projectPath, reportFontIssues: false,
          })
          return exportProjectCache(info.sha1, source, directory)
        },
      })
      log.info(`project:consolidate verified → ${result.path}`)
      // Keep the live project and playlist: the operator may have edited them during transfer.
      return { ok: true, ...result }
    } catch (err) {
      const error = (err as NodeJS.ErrnoException).code === 'ENOSPC'
        ? t('На выбранном диске закончилось место. Освободи место или выбери другой диск и повтори сборку.')
        : (err as Error).message
      progress({ phase: 'error', completed: 0, total: 0, file: '', error })
      log.error('project:consolidate', error)
      return { ok: false, error }
    } finally {
      endProjectTransfer()
    }
  })

  /** Ручная перепроверка материалов — кнопка «Проверить файлы» у оператора. */
  ipcMain.handle(
    'playlist:check-files',
    async (): Promise<{ missing: number; total: number }> => {
      const missing = await refreshMissingFiles()
      return { missing, total: store.get().playlist.length }
    },
  )

  /** Only known playlist sources may be revealed, never a renderer-supplied arbitrary path. */
  ipcMain.handle('playlist:reveal-source', async (_e, id: unknown, itemPath?: unknown) => {
    const entry = typeof id === 'string' ? store.get().playlist.find((item) => item.id === id) : undefined
    const path = entry?.kind === 'list'
      ? entry.items?.find((item) => item.path === itemPath)?.path
      : entry?.kind !== 'live' ? entry?.filePath : undefined
    if (!path || !isAbsolute(path) || isLiveUri(path)) {
      return { ok: false, error: t('У этого материала нет исходного файла') }
    }
    try {
      if (!(await stat(path)).isFile()) throw new Error('Not a file')
    } catch {
      return { ok: false, error: t('Исходный файл не найден: {name}', { name: basename(path) }) }
    }
    try {
      shell.showItemInFolder(path)
      return { ok: true }
    } catch { return { ok: false, error: t('Не удалось показать исходный файл') } }
  })

  /** Relink a moved material while preserving its playlist settings. */
  ipcMain.handle('playlist:relocate', async (_e, id: string): Promise<boolean> => {
    const entry = store.get().playlist.find((e) => e.id === id)
    // У списка материалов много — их чинит «Найти в папке…» или правка списка.
    if (!entry || entry.kind === 'live' || entry.kind === 'list') return false
    const op = getOperatorWindow()
    const res = await dialog.showOpenDialog(op!, {
      title: t('Указать файл для «{name}»', { name: entry.displayName || entry.fileName }),
      filters: openDialogFilters(),
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
  await waitForSessionRestore()
  flushSessionCheckpoint()
  await notesWriter.flush()
  await flushProjectWrites()
}
