import { dialog, globalShortcut, ipcMain, screen } from 'electron'
import { readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { DisplayMap, Layout } from './layout.js'
import type {
  DeckState,
  FileKind,
  PlaylistEntry,
  SlideMedia,
  TimerMode,
  TimerPosition,
  VideoTakeMode,
} from './state.js'
import { store, initialDeckState, DEFAULT_SPEAKER_MSG_PRESETS } from './state.js'
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
  setTimerTickEnabled,
  setTimerGongEnabled,
  setTimerLoop,
  getAskLayoutOnStartup,
  setAskLayoutOnStartup,
  setClickerGlobal,
  getClickerGlobalArrows,
  setClickerGlobalArrows,
  setSpeakerMsgPresets,
  setOutputMonitorsEnabled,
  setUiTheme,
} from './display-mapping.js'
import { countPdfPages } from './pdf-pages.js'
import { cachedPdfPathFor, convertPptxToPdf, findSoffice } from './pptx-converter.js'
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

/** Load a file straight to the PROGRAM (audience) feed. */
async function openFile(
  filePath: string,
  opts: { playlistId?: string | null; durationMs?: number } = {},
): Promise<OpenPdfResult> {
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

    store.patch({
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
    return { ok: false, error: (err as Error).message }
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
    return { ok: false, error: (err as Error).message }
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
  const state = store.get()
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
    if (!pdfPath) return null
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
    if (!path) return null
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

  ipcMain.handle('preview:next', () => {
    const { currentSlide, totalSlides } = store.get().preview
    if (currentSlide < totalSlides) {
      store.patchPreview({ currentSlide: currentSlide + 1 })
      resetPreviewVideoOnSlideChange()
    }
  })

  ipcMain.handle('preview:prev', () => {
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

    // New program video: always autoplayed on take; mode only picks start point.
    // Слайд-видео в PPTX на эфир не автоплеится — оператор запускает вручную.
    let video: import('./state.js').VideoState
    if (p.kind === 'video') {
      const resume = state.videoTakeMode === 'play-resume'
      const startSec = resume ? store.previewVideoPositionSec() : 0
      video = {
        playing: true,
        anchorSec: startSec,
        anchorAt: Date.now(),
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
    const v = store.get().preview.video
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

  // Texts of the three preset buttons are user-editable (ПКМ по кнопке);
  // holes/empties fall back to the defaults slot by slot.
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
    const v = store.get().video
    store.patchVideo({ playing: false, anchorSec: v.durationSec || v.anchorSec, anchorAt: null })
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
        fileName: basename(p),
        displayName: '',
        speakerName: '',
        durationMs: defaultDur,
      })
    }
    if (newEntries.length > 0) {
      store.patch({ playlist: [...existing, ...newEntries] })
      persistPlaylist()
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

  // Drag & drop из Finder/Explorer: пути приходят из рендерера (webUtils).
  ipcMain.handle('playlist:add-paths', (_e, paths: string[]): PlaylistEntry[] => {
    if (!Array.isArray(paths)) return []
    return appendToPlaylist(paths)
  })

  ipcMain.handle('playlist:remove', (_e, id: string) => {
    const next = store.get().playlist.filter((e) => e.id !== id)
    const patch: Partial<import('./state.js').AppState> = { playlist: next }
    if (store.get().currentPlaylistId === id) {
      patch.currentPlaylistId = null
      setCurrentPlaylistId(null)
    }
    store.patch(patch)
    persistPlaylist()
  })

  ipcMain.handle('playlist:reorder', (_e, ids: string[]) => {
    const map = new Map(store.get().playlist.map((e) => [e.id, e]))
    const reordered = ids.map((id) => map.get(id)).filter((e): e is PlaylistEntry => Boolean(e))
    store.patch({ playlist: reordered })
    persistPlaylist()
  })

  ipcMain.handle(
    'playlist:update',
    (_e, payload: { id: string; displayName?: string; speakerName?: string; durationMs?: number }) => {
      const next = store.get().playlist.map((e) =>
        e.id === payload.id
          ? {
              ...e,
              displayName: payload.displayName ?? e.displayName,
              speakerName: payload.speakerName ?? e.speakerName,
              durationMs:
                typeof payload.durationMs === 'number' ? payload.durationMs : e.durationMs,
            }
          : e,
      )
      store.patch({ playlist: next })
      persistPlaylist()

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
    return loadPreview(entry.filePath, { playlistId: id })
  })

  // Double click / explicit "to air": load straight to the program feed.
  ipcMain.handle('playlist:activate-live', async (_e, id: string): Promise<OpenPdfResult> => {
    const entry = store.get().playlist.find((e) => e.id === id)
    if (!entry) return { ok: false, error: 'Entry not found' }
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
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
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
    async (_e, payload: { saveAs?: boolean } = {}): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const op = getOperatorWindow()
      const state = store.get()
      let target = state.projectPath
      if (!target || payload.saveAs) {
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
    },
  )

  ipcMain.handle(
    'project:open',
    async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
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
        return { ok: true, path }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  )
}

export async function flushPendingWrites(): Promise<void> {
  await notesWriter.flush()
}
