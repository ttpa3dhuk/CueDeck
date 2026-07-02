import { initBus, getState, subscribe } from '../shared/bus'
import { loadDocument, renderPageTo, prerender, totalPages, PdfLoader } from '../shared/pdf-loader'
import { startTick, timerView, type TimerView } from '../shared/timer'
import { applySinkId, formatClock, shouldMute, syncVideoElement, videoPosition, videoSrc } from '../shared/video'
import type {
  AppState,
  DisplayInfo,
  DisplayMap,
  Layout,
  PlaylistEntry,
  Role,
  TimerMode,
  TimerPosition,
  VideoTakeMode,
} from '../../preload/api'

const role: Role = (new URL(location.href).searchParams.get('role') as Role) ?? 'operator'
document.body.dataset.role = role

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// Имя файла из пути — и POSIX, и Windows-разделители
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? ''

const slidePlaceholder = $('slide-placeholder')
const pdfName = $('pdf-name')
const slideCounter = $('slide-counter')
const slideRemaining = $('slide-remaining')
const timerDisplay = $('timer-display')
const timerToggle = $<HTMLButtonElement>('timer-toggle')
const timerReset = $<HTMLButtonElement>('timer-reset')
const blackoutToggle = $<HTMLButtonElement>('blackout-toggle')
const durationInput = role === 'operator' ? $<HTMLInputElement>('duration-input') : null
const modeSelect = role === 'operator' ? $<HTMLSelectElement>('mode-select') : null
const playlistList = role === 'operator' ? $<HTMLOListElement>('playlist-list') : null
const playlistEmpty = role === 'operator' ? $('playlist-empty') : null
const playlistAddBtn = role === 'operator' ? $<HTMLButtonElement>('playlist-add') : null
const playlistCompactToggle = role === 'operator' ? $<HTMLInputElement>('playlist-compact-toggle') : null
const playlistAutoAdvanceToggle = role === 'operator' ? $<HTMLInputElement>('playlist-auto-advance-toggle') : null
const kvPreview = role === 'operator' ? $('kv-preview') : null
const kvSetBtn = role === 'operator' ? $<HTMLButtonElement>('kv-set') : null
const kvClearBtn = role === 'operator' ? $<HTMLButtonElement>('kv-clear') : null

let sofficePresentCache: boolean | null = null

async function checkSoffice(): Promise<boolean> {
  if (sofficePresentCache !== null) return sofficePresentCache
  sofficePresentCache = await window.api.soffice.check()
  return sofficePresentCache
}

let kvBlobUrl: string | null = null
let kvLoadedForPath: string | null | undefined = undefined

async function refreshKeyVisualPreview(state: AppState): Promise<void> {
  if (!kvPreview || !kvClearBtn) return
  const path = state.keyVisualPath
  kvClearBtn.disabled = !path

  if (path === kvLoadedForPath) return
  kvLoadedForPath = path

  if (kvBlobUrl) {
    URL.revokeObjectURL(kvBlobUrl)
    kvBlobUrl = null
  }

  if (!path) {
    kvPreview.classList.add('kv-empty')
    kvPreview.textContent = 'Нет заставки — Blackout покажет чёрный экран'
    kvPreview.style.backgroundImage = ''
    return
  }

  const data = await window.api.keyvisual.read()
  if (!data) {
    kvPreview.classList.add('kv-empty')
    kvPreview.textContent = 'Не удалось загрузить файл'
    kvPreview.style.backgroundImage = ''
    return
  }
  const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
  kvBlobUrl = URL.createObjectURL(blob)
  kvPreview.classList.remove('kv-empty')
  kvPreview.textContent = ''
  kvPreview.style.backgroundImage = `url(${kvBlobUrl})`
}
const currentCanvas = $<HTMLCanvasElement>('current-canvas')
const currentImage = $<HTMLImageElement>('current-image')
const currentVideo = $<HTMLVideoElement>('current-video')
const videoControls = role === 'operator' ? $('video-controls') : null
const videoPlayBtn = role === 'operator' ? $<HTMLButtonElement>('video-play') : null
const videoRestartBtn = role === 'operator' ? $<HTMLButtonElement>('video-restart') : null
const videoScrub = role === 'operator' ? $<HTMLInputElement>('video-scrub') : null
const videoTime = role === 'operator' ? $('video-time') : null
const videoMuteBtn = role === 'operator' ? $<HTMLButtonElement>('video-mute') : null
const videoError = $('video-error')
const nextCanvas = $<HTMLCanvasElement>('next-canvas')
const nextEmpty = $('next-empty')
const notesInput = $<HTMLTextAreaElement>('notes-input')
const notesReadonly = $('notes-readonly')
const banner = $('banner')
const setupModal = $('setup-modal')

let docLoaded = false
let lastRenderedSlide = -1
let currentImageBlobUrl: string | null = null
let lastSinkId: string | null | undefined = undefined

// ── Preview deck (operator only) ───────────────────────────────────────────
const isOperator = role === 'operator'
const previewCanvas = isOperator ? $<HTMLCanvasElement>('preview-canvas') : null
const previewImage = isOperator ? $<HTMLImageElement>('preview-image') : null
const previewVideo = isOperator ? $<HTMLVideoElement>('preview-video') : null
const previewPlaceholder = isOperator ? $('preview-placeholder') : null
const previewVideoControls = isOperator ? $('preview-video-controls') : null
const previewVideoPlay = isOperator ? $<HTMLButtonElement>('preview-video-play') : null
const previewVideoRestart = isOperator ? $<HTMLButtonElement>('preview-video-restart') : null
const previewVideoScrub = isOperator ? $<HTMLInputElement>('preview-video-scrub') : null
const previewVideoTime = isOperator ? $('preview-video-time') : null
const previewVideoError = isOperator ? $('preview-video-error') : null
const previewPrevBtn = isOperator ? $<HTMLButtonElement>('preview-prev') : null
const previewNextBtn = isOperator ? $<HTMLButtonElement>('preview-next') : null
const previewCounter = isOperator ? $('preview-counter') : null
const takeBtn = isOperator ? $<HTMLButtonElement>('take-btn') : null
const videoTakeModeSelect = isOperator ? $<HTMLSelectElement>('video-take-mode') : null

// ── Speaker flash message (1.1) ────────────────────────────────────────────
const speakerMessageOverlay = $('speaker-message')
const smInput = isOperator ? $<HTMLInputElement>('sm-input') : null
const smClear = isOperator ? $<HTMLButtonElement>('sm-clear') : null

const previewLoader = isOperator ? new PdfLoader() : null
let previewDocLoaded = false
let previewLastRenderedSlide = -1
let previewImageBlobUrl: string | null = null
let prevPreviewPath: string | null = null

function clearCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')
  if (ctx) {
    canvas.width = 1
    canvas.height = 1
    ctx.clearRect(0, 0, 1, 1)
  }
}

function disposeCurrentImage(): void {
  if (currentImageBlobUrl) {
    URL.revokeObjectURL(currentImageBlobUrl)
    currentImageBlobUrl = null
  }
}

function unloadCurrentVideo(): void {
  if (currentVideo.src) {
    currentVideo.pause()
    currentVideo.removeAttribute('src')
    currentVideo.load()
  }
  currentVideo.classList.add('hidden')
}

async function loadCurrentFile(): Promise<void> {
  const state = getState()
  disposeCurrentImage()
  docLoaded = false
  lastRenderedSlide = -1
  videoError.classList.add('hidden')

  if (state.fileKind === 'video') {
    slidePlaceholder.classList.add('hidden')
    currentCanvas.classList.add('hidden')
    currentImage.classList.add('hidden')
    currentImage.removeAttribute('src')
    clearCanvas(nextCanvas)
    nextCanvas.classList.add('hidden')
    nextEmpty.classList.remove('hidden')
    currentVideo.classList.remove('hidden')
    currentVideo.muted = shouldMute(state, role)
    currentVideo.src = videoSrc(state.pdfSha1 ?? '', 'program')
    currentVideo.load()
    lastSinkId = state.audioOutputId
    applySinkId(currentVideo, state.audioOutputId)
    await window.api.pdf.reportTotal(1)
    syncVideoElement(currentVideo, state.video)
    return
  }

  unloadCurrentVideo()

  const data = await window.api.pdf.read()
  if (!data) return

  slidePlaceholder.classList.add('hidden')

  if (state.fileKind === 'image') {
    const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
    currentImageBlobUrl = URL.createObjectURL(blob)
    currentImage.src = currentImageBlobUrl
    currentImage.classList.remove('hidden')
    currentCanvas.classList.add('hidden')
    clearCanvas(nextCanvas)
    nextCanvas.classList.add('hidden')
    nextEmpty.classList.remove('hidden')
    await window.api.pdf.reportTotal(1)
    return
  }

  // PDF path (also covers pptx converted to pdf)
  currentImage.classList.add('hidden')
  currentImage.removeAttribute('src')
  currentCanvas.classList.remove('hidden')
  nextCanvas.classList.remove('hidden')
  nextEmpty.classList.add('hidden')
  await loadDocument(data.bytes)
  docLoaded = true
  await window.api.pdf.reportTotal(totalPages())
  await renderCurrent()
}

async function renderCurrent(): Promise<void> {
  const state = getState()
  if (state.fileKind === 'image' || state.fileKind === null) return
  if (!docLoaded) return
  const slide = state.currentSlide
  if (slide === lastRenderedSlide) return
  lastRenderedSlide = slide

  const slideEl = currentCanvas.parentElement!
  const currentWidth = slideEl.clientWidth
  await renderPageTo(slide, currentCanvas, currentWidth)

  const nextWidth = nextCanvas.parentElement!.clientWidth
  if (slide + 1 <= state.totalSlides) {
    await renderPageTo(slide + 1, nextCanvas, nextWidth)
    prerender(slide + 2, currentWidth).catch(() => undefined)
  } else {
    clearCanvas(nextCanvas)
  }
}

// Reflects the shared video clock into the operator transport bar. Scrub/time
// also refresh on a tick (see bootstrap) so they advance live during playback.
function updateVideoUI(state: AppState): void {
  const isVideo = state.fileKind === 'video'
  if (videoControls) videoControls.classList.toggle('hidden', !isVideo)
  if (!isVideo || role !== 'operator') return

  const v = state.video
  if (videoPlayBtn) videoPlayBtn.textContent = v.playing ? '⏸' : '▶'
  if (videoMuteBtn) {
    videoMuteBtn.textContent = v.muted ? '🔇' : '🔊'
    videoControls?.classList.toggle('muted', v.muted)
  }
  const pos = videoPosition(v)
  const dur = v.durationSec || 0
  if (videoScrub && document.activeElement !== videoScrub) {
    videoScrub.max = String(dur > 0 ? dur : 100)
    videoScrub.value = String(dur > 0 ? Math.min(pos, dur) : pos)
  }
  if (videoTime) videoTime.textContent = `${formatClock(pos)} / ${formatClock(dur)}`
}

// Mirrors the slide counter for video: shows elapsed/total in the center of the
// topbar plus remaining time. Visible to both operator and speaker. Refreshed on
// the tick so it counts down live; turns orange in the last 30s, red in the last 10s.
const VIDEO_WARN_SEC = 30
const VIDEO_DANGER_SEC = 10
function updateVideoHeader(state: AppState): void {
  if (state.fileKind !== 'video') return
  const v = state.video
  const pos = videoPosition(v)
  const dur = v.durationSec || 0
  slideCounter.classList.add('video')
  slideRemaining.classList.add('big')
  if (dur > 0) {
    slideCounter.textContent = `Видео ${formatClock(pos)} / ${formatClock(dur)}`
    const remaining = Math.max(0, dur - pos)
    slideRemaining.textContent = formatClock(remaining)
    slideRemaining.classList.toggle('warn', remaining > VIDEO_DANGER_SEC && remaining <= VIDEO_WARN_SEC)
    slideRemaining.classList.toggle('ending', remaining <= VIDEO_DANGER_SEC)
  } else {
    slideCounter.textContent = 'Видео'
    slideRemaining.textContent = ''
    slideRemaining.classList.remove('warn', 'ending', 'big'); slideCounter.classList.remove('video')
  }
}

// ── Preview deck rendering (operator only) ─────────────────────────────────
// Mirrors the program-pane logic but against state.preview + its own PdfLoader.
// Preview audio is always muted; the clicker never touches it.

function disposePreviewImage(): void {
  if (previewImageBlobUrl) {
    URL.revokeObjectURL(previewImageBlobUrl)
    previewImageBlobUrl = null
  }
}

function unloadPreviewVideo(): void {
  if (!previewVideo) return
  if (previewVideo.src) {
    previewVideo.pause()
    previewVideo.removeAttribute('src')
    previewVideo.load()
  }
  previewVideo.classList.add('hidden')
}

async function loadPreviewFile(): Promise<void> {
  if (!previewLoader || !previewVideo || !previewCanvas || !previewImage || !previewPlaceholder) return
  const p = getState().preview
  disposePreviewImage()
  previewDocLoaded = false
  previewLastRenderedSlide = -1
  previewVideoError?.classList.add('hidden')

  if (!p.path) {
    unloadPreviewVideo()
    previewCanvas.classList.add('hidden')
    previewImage.classList.add('hidden')
    previewImage.removeAttribute('src')
    previewPlaceholder.classList.remove('hidden')
    return
  }

  previewPlaceholder.classList.add('hidden')

  if (p.kind === 'video') {
    previewCanvas.classList.add('hidden')
    previewImage.classList.add('hidden')
    previewImage.removeAttribute('src')
    previewVideo.classList.remove('hidden')
    previewVideo.muted = true
    previewVideo.src = videoSrc(p.sha1 ?? '', 'preview')
    previewVideo.load()
    await window.api.preview.reportTotal(1)
    syncVideoElement(previewVideo, p.video)
    return
  }

  unloadPreviewVideo()

  const data = await window.api.preview.read()
  if (!data) return

  if (p.kind === 'image') {
    const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
    previewImageBlobUrl = URL.createObjectURL(blob)
    previewImage.src = previewImageBlobUrl
    previewImage.classList.remove('hidden')
    previewCanvas.classList.add('hidden')
    await window.api.preview.reportTotal(1)
    return
  }

  // PDF / converted PPTX
  previewImage.classList.add('hidden')
  previewImage.removeAttribute('src')
  previewCanvas.classList.remove('hidden')
  await previewLoader.loadDocument(data.bytes)
  previewDocLoaded = true
  await window.api.preview.reportTotal(previewLoader.totalPages())
  await renderPreview()
}

async function renderPreview(): Promise<void> {
  if (!previewLoader || !previewCanvas) return
  const p = getState().preview
  if (p.kind === 'image' || p.kind === null || p.kind === 'video') return
  if (!previewDocLoaded) return
  if (p.currentSlide === previewLastRenderedSlide) return
  previewLastRenderedSlide = p.currentSlide
  const width = previewCanvas.parentElement!.clientWidth
  await previewLoader.renderPageTo(p.currentSlide, previewCanvas, width)
  if (p.currentSlide + 1 <= p.totalSlides) {
    previewLoader.prerender(p.currentSlide + 1, width).catch(() => undefined)
  }
}

function updatePreviewUI(state: AppState): void {
  if (!isOperator) return
  const p = state.preview
  if (takeBtn) takeBtn.disabled = !p.path
  if (previewCounter) {
    previewCounter.textContent = p.path
      ? p.kind === 'video'
        ? 'видео'
        : `${p.currentSlide} / ${p.totalSlides || '—'}`
      : '— / —'
  }
  const isVideo = p.kind === 'video'
  previewVideoControls?.classList.toggle('hidden', !isVideo)
  videoTakeModeSelect?.classList.toggle('hidden', !isVideo)
  if (videoTakeModeSelect && document.activeElement !== videoTakeModeSelect && videoTakeModeSelect.value !== state.videoTakeMode) {
    videoTakeModeSelect.value = state.videoTakeMode
  }
  if (isVideo) {
    const v = p.video
    if (previewVideoPlay) previewVideoPlay.textContent = v.playing ? '⏸' : '▶'
    const pos = videoPosition(v)
    const dur = v.durationSec || 0
    if (previewVideoScrub && document.activeElement !== previewVideoScrub) {
      previewVideoScrub.max = String(dur > 0 ? dur : 100)
      previewVideoScrub.value = String(dur > 0 ? Math.min(pos, dur) : pos)
    }
    if (previewVideoTime) previewVideoTime.textContent = `${formatClock(pos)} / ${formatClock(dur)}`
  }
}

async function handlePreviewChange(state: AppState): Promise<void> {
  if (!isOperator || !previewVideo) return
  updatePreviewUI(state)
  const p = state.preview
  if (p.path !== prevPreviewPath) {
    prevPreviewPath = p.path
    previewLastRenderedSlide = -1
    await loadPreviewFile()
  } else if (p.kind === 'video') {
    previewVideo.muted = true
    syncVideoElement(previewVideo, p.video)
  } else if (p.currentSlide !== previewLastRenderedSlide) {
    await renderPreview()
  }
}

// Speaker flash message: overlay on the speaker monitor (blinks via CSS until
// cleared) + operator-side controls state (active preset highlight, «Снять»).
function updateSpeakerMessage(state: AppState): void {
  const msg = state.speakerMessage
  speakerMessageOverlay.textContent = msg ?? ''
  speakerMessageOverlay.classList.toggle('hidden', !msg)
  if (!isOperator) return
  let presetActive = false
  document.querySelectorAll<HTMLButtonElement>('button.sm-preset').forEach((btn) => {
    const active = msg !== null && btn.dataset.msg === msg
    btn.classList.toggle('active', active)
    if (active) presetActive = true
  })
  if (smClear) smClear.disabled = !msg
  if (smInput && document.activeElement !== smInput) {
    smInput.value = msg && !presetActive ? msg : ''
  }
}

function applyTimerView(view: TimerView): void {
  let cls = `timer ${view.color}`
  if (view.overtime) cls += ' overtime'
  timerDisplay.className = cls
  timerDisplay.textContent = view.text
}

const playlistNodes = new Map<string, HTMLLIElement>()

// live=false → load into off-air preview deck; live=true → straight to program.
async function activateEntry(entry: PlaylistEntry, live: boolean): Promise<void> {
  if (live) {
    // Guard: don't cut a video that's live on the audience screen by accident.
    const st = getState()
    if (st.fileKind === 'video' && st.video.playing && st.currentPlaylistId !== entry.id) {
      const ok = window.confirm(
        `Сейчас на экране идёт видео. Прервать его и выдать в эфир «${entry.displayName || entry.fileName}»?`,
      )
      if (!ok) return
    }
  }
  if (entry.kind === 'pptx') {
    const hasLo = await checkSoffice()
    if (!hasLo) {
      showLoModal()
      return
    }
    showBanner('Конвертация PPTX через LibreOffice…', 60_000)
  }
  const res = live
    ? await window.api.playlist.activateLive(entry.id)
    : await window.api.playlist.activate(entry.id)
  if (entry.kind === 'pptx') banner.classList.add('hidden')
  if (!res.ok && res.error) showBanner(`Ошибка: ${res.error}`, 8000)
}

// Inline rename of a playlist entry's display label (the file on disk is untouched).
function startRename(li: HTMLLIElement, entry: PlaylistEntry): void {
  const nameEl = li.querySelector<HTMLSpanElement>('.pdf-name')
  if (!nameEl || li.querySelector('.rename-input')) return
  const input = document.createElement('input')
  input.className = 'rename-input'
  input.type = 'text'
  input.value = entry.displayName || entry.fileName
  input.placeholder = entry.fileName
  const stop = (e: Event): void => e.stopPropagation()
  input.addEventListener('click', stop)
  input.addEventListener('mousedown', stop)
  input.addEventListener('dblclick', stop)
  let done = false
  const restore = (): void => {
    if (input.isConnected) input.replaceWith(nameEl)
  }
  const commit = (): void => {
    if (done) return
    done = true
    const val = input.value.trim()
    // Empty or equal to the real filename → store '' so we fall back to fileName.
    const displayName = val === '' || val === entry.fileName ? '' : val
    window.api.playlist.update(entry.id, { displayName })
    restore()
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') { done = true; restore() }
  })
  input.addEventListener('blur', commit)
  nameEl.replaceWith(input)
  input.focus()
  input.select()
}

function createPlaylistItem(entry: PlaylistEntry): HTMLLIElement {
  // Узел живёт дольше объекта entry (стейт иммутабельный) — обработчики берут
  // свежую версию записи из стейта, иначе rename/confirm видят устаревшие поля.
  const fresh = (): PlaylistEntry =>
    getState().playlist.find((x) => x.id === entry.id) ?? entry
  const li = document.createElement('li')
  li.className = 'playlist-item'
  li.draggable = true
  li.dataset.id = entry.id

  const row1 = document.createElement('div')
  row1.className = 'row'

  const handle = document.createElement('span')
  handle.className = 'drag-handle'
  handle.textContent = '⋮⋮'

  const kindBadge = document.createElement('span')
  kindBadge.className = `kind-badge kind-${entry.kind}`
  kindBadge.textContent =
    entry.kind === 'pptx'
      ? 'PPTX'
      : entry.kind === 'image'
        ? 'IMG'
        : entry.kind === 'video'
          ? 'VIDEO'
          : 'PDF'

  const name = document.createElement('span')
  name.className = 'pdf-name'
  name.textContent = entry.displayName || entry.fileName
  name.title = entry.filePath

  const renameBtn = document.createElement('button')
  renameBtn.className = 'rename'
  renameBtn.textContent = '✎'
  renameBtn.title = 'Переименовать в списке (имя файла не меняется)'
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    startRename(li, fresh())
  })

  const removeBtn = document.createElement('button')
  removeBtn.className = 'remove'
  removeBtn.textContent = '✕'
  removeBtn.title = 'Удалить из плейлиста'
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    window.api.playlist.remove(entry.id)
  })

  row1.append(handle, kindBadge, name, renameBtn, removeBtn)

  const speakerInput = document.createElement('input')
  speakerInput.type = 'text'
  speakerInput.className = 'speaker-name'
  speakerInput.placeholder = 'Имя спикера'
  speakerInput.value = entry.speakerName
  speakerInput.addEventListener('click', (e) => e.stopPropagation())
  speakerInput.addEventListener('mousedown', (e) => e.stopPropagation())
  let speakerDebounce: number | null = null
  speakerInput.addEventListener('input', () => {
    if (speakerDebounce) window.clearTimeout(speakerDebounce)
    speakerDebounce = window.setTimeout(() => {
      window.api.playlist.update(entry.id, { speakerName: speakerInput.value })
    }, 400)
  })

  const durRow = document.createElement('div')
  durRow.className = 'duration-row'
  const durLabel = document.createElement('span')
  durLabel.textContent = 'Таймер:'
  const durInput = document.createElement('input')
  durInput.type = 'number'
  durInput.min = '0'
  durInput.step = '1'
  durInput.className = 'duration'
  durInput.value = String(Math.round(entry.durationMs / 60000))
  durInput.addEventListener('click', (e) => e.stopPropagation())
  durInput.addEventListener('mousedown', (e) => e.stopPropagation())
  let durDebounce: number | null = null
  durInput.addEventListener('input', () => {
    if (durDebounce) window.clearTimeout(durDebounce)
    durDebounce = window.setTimeout(() => {
      const min = Math.max(0, Math.floor(Number(durInput.value) || 0))
      window.api.playlist.update(entry.id, { durationMs: min * 60_000 })
    }, 400)
  })
  const durSuffix = document.createElement('span')
  durSuffix.textContent = 'мин'
  durRow.append(durLabel, durInput, durSuffix)

  li.append(row1, speakerInput, durRow)

  // Single click → stage into preview (safe). Double click → straight to air.
  let clickTimer: number | null = null
  li.addEventListener('click', () => {
    if (clickTimer) window.clearTimeout(clickTimer)
    clickTimer = window.setTimeout(() => {
      clickTimer = null
      activateEntry(fresh(), false)
    }, 220)
  })
  li.addEventListener('dblclick', () => {
    if (clickTimer) {
      window.clearTimeout(clickTimer)
      clickTimer = null
    }
    activateEntry(fresh(), true)
  })

  li.addEventListener('dragstart', (e) => {
    li.classList.add('dragging')
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', entry.id)
    }
  })
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging')
    document
      .querySelectorAll('.playlist-item.drop-target')
      .forEach((n) => n.classList.remove('drop-target'))
  })
  li.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    li.classList.add('drop-target')
  })
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-target')
  })
  li.addEventListener('drop', (e) => {
    e.preventDefault()
    li.classList.remove('drop-target')
    const draggedId = e.dataTransfer?.getData('text/plain')
    if (draggedId && draggedId !== entry.id) reorderAroundTarget(draggedId, entry.id)
  })

  return li
}

function updatePlaylistItem(node: HTMLLIElement, entry: PlaylistEntry): void {
  const name = node.querySelector<HTMLSpanElement>('.pdf-name')
  if (name) {
    name.textContent = entry.displayName || entry.fileName
    name.title = entry.displayName ? `${entry.fileName}\n${entry.filePath}` : entry.filePath
  }
  const speakerInput = node.querySelector<HTMLInputElement>('.speaker-name')
  if (speakerInput && document.activeElement !== speakerInput) {
    speakerInput.value = entry.speakerName
  }
  const durInput = node.querySelector<HTMLInputElement>('input.duration')
  if (durInput && document.activeElement !== durInput) {
    durInput.value = String(Math.round(entry.durationMs / 60000))
  }
}

function reorderAroundTarget(draggedId: string, targetId: string): void {
  const state = getState()
  const ids = state.playlist.map((e) => e.id).filter((id) => id !== draggedId)
  const targetIdx = ids.indexOf(targetId)
  if (targetIdx < 0) return
  ids.splice(targetIdx, 0, draggedId)
  window.api.playlist.reorder(ids)
}

function updateLibreOfficeNotice(state: AppState): void {
  const notice = document.getElementById('libreoffice-notice')
  if (!notice) return
  const hasPptx = state.playlist.some((e) => e.kind === 'pptx')
  if (hasPptx && sofficePresentCache === false) {
    notice.classList.remove('hidden')
  } else {
    notice.classList.add('hidden')
  }
}

function renderPlaylist(state: AppState): void {
  if (!playlistList || !playlistEmpty) return

  const entries = state.playlist
  playlistEmpty.classList.toggle('hidden', entries.length > 0)

  const wantedIds = new Set(entries.map((e) => e.id))
  for (const [id, node] of playlistNodes) {
    if (!wantedIds.has(id)) {
      node.remove()
      playlistNodes.delete(id)
    }
  }

  entries.forEach((entry, idx) => {
    let node = playlistNodes.get(entry.id)
    if (!node) {
      node = createPlaylistItem(entry)
      playlistNodes.set(entry.id, node)
    } else {
      updatePlaylistItem(node, entry)
    }
    const at = playlistList.children[idx]
    if (at !== node) playlistList.insertBefore(node, at ?? null)
  })

  for (const [id, node] of playlistNodes) {
    node.classList.toggle('on-air', id === state.currentPlaylistId)
    node.classList.toggle('in-preview', id === state.preview.playlistId)
  }

  updateLibreOfficeNotice(state)
}

function applyState(state: AppState): void {
  if (state.pdfPath) {
    slidePlaceholder.classList.add('hidden')
    pdfName.textContent = baseName(state.pdfPath)
    if (state.fileKind === 'video') {
      updateVideoHeader(state)
    } else {
      slideRemaining.classList.remove('warn', 'ending', 'big'); slideCounter.classList.remove('video')
      slideCounter.textContent = `Слайд ${state.currentSlide} из ${state.totalSlides || '—'}`
      const remaining = Math.max(0, (state.totalSlides || 0) - state.currentSlide)
      slideRemaining.textContent = state.totalSlides > 0 ? `(осталось ${remaining})` : ''
    }
  } else {
    slidePlaceholder.classList.remove('hidden')
    pdfName.textContent = ''
    slideRemaining.classList.remove('warn', 'ending', 'big'); slideCounter.classList.remove('video')
    slideCounter.textContent = 'Слайд — из —'
    slideRemaining.textContent = ''
    currentCanvas.classList.add('hidden')
    currentImage.classList.add('hidden')
    currentImage.removeAttribute('src')
    currentVideo.classList.add('hidden')
    videoError.classList.add('hidden')
    nextCanvas.classList.add('hidden')
    nextEmpty.classList.add('hidden')
  }

  updateVideoUI(state)

  timerToggle.textContent = state.timer.running ? '⏸' : '▶'
  blackoutToggle.style.background = state.blackout ? 'var(--danger)' : ''

  if (durationInput && document.activeElement !== durationInput) {
    const minutes = Math.round(state.timer.durationMs / 60000)
    durationInput.value = String(minutes)
  }
  if (modeSelect && modeSelect.value !== state.timerMode) {
    modeSelect.value = state.timerMode
  }
  document.body.dataset.timerPosition = state.timerPosition
  document.documentElement.style.setProperty(
    '--notes-font-size',
    `${state.notesFontSize}px`,
  )
  document.documentElement.style.setProperty(
    '--timer-scale',
    String(state.timerScale),
  )
  const notesFontValueEl = document.getElementById('notes-font-value')
  if (notesFontValueEl) notesFontValueEl.textContent = String(state.notesFontSize)
  const scaleValueEl = document.getElementById('timer-scale-value')
  if (scaleValueEl) scaleValueEl.textContent = `${Math.round(state.timerScale * 100)}%`
  if (role === 'operator') {
    document
      .querySelectorAll<HTMLButtonElement>('button.position-btn')
      .forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.pos === state.timerPosition)
      })
  }

  const noteText = state.notes[state.currentSlide] ?? ''
  if (role === 'operator') {
    if (document.activeElement !== notesInput) notesInput.value = noteText
  } else {
    notesReadonly.textContent = noteText
  }

  if (playlistCompactToggle && playlistCompactToggle.checked !== state.playlistCompact) {
    playlistCompactToggle.checked = state.playlistCompact
    playlistList?.classList.toggle('compact', state.playlistCompact)
  }
  if (playlistAutoAdvanceToggle && playlistAutoAdvanceToggle.checked !== state.autoAdvance) {
    playlistAutoAdvanceToggle.checked = state.autoAdvance
  }

  renderPlaylist(state)
  updateSpeakerMessage(state)
  refreshKeyVisualPreview(state).catch(() => undefined)
}

async function projectNew(): Promise<void> {
  const state = getState()
  if (state.playlist.length > 0 || state.keyVisualPath) {
    const ok = window.confirm('Очистить текущий плейлист и начать новый проект?')
    if (!ok) return
  }
  await window.api.project.create()
  showBanner('Новый проект', 2000)
  // Re-enable "Последний" so the user can go back to the previous session
  if (role === 'operator') {
    window.api.session.hasLast().then((has) => {
      $<HTMLButtonElement>('btn-last').disabled = !has
    }).catch(() => undefined)
  }
}

async function projectOpen(): Promise<void> {
  const res = await window.api.project.open()
  if (res.ok && res.path) {
    showBanner(`Открыт: ${baseName(res.path)}`, 3000)
  } else if (!res.ok && res.error) {
    showBanner(`Ошибка: ${res.error}`, 6000)
  }
}

async function projectSave(saveAs: boolean = false): Promise<void> {
  const res = await window.api.project.save(saveAs)
  if (res.ok && res.path) {
    showBanner(`Сохранено: ${baseName(res.path)}`, 3000)
  } else if (!res.ok && res.error) {
    showBanner(`Ошибка сохранения: ${res.error}`, 6000)
  }
}

let prevFilePath: string | null = null
let prevSlide = 0

async function handleStateChange(state: AppState, patch: Partial<AppState> | null): Promise<void> {
  applyState(state)

  if (isOperator) handlePreviewChange(state).catch(() => undefined)

  if (state.pdfPath && state.pdfPath !== prevFilePath) {
    prevFilePath = state.pdfPath
    lastRenderedSlide = -1
    await loadCurrentFile()
  } else if (state.fileKind === 'video') {
    currentVideo.muted = shouldMute(state, role)
    if (state.audioOutputId !== lastSinkId) {
      lastSinkId = state.audioOutputId
      applySinkId(currentVideo, state.audioOutputId)
    }
    syncVideoElement(currentVideo, state.video)
  } else if (state.currentSlide !== prevSlide || patch === null) {
    prevSlide = state.currentSlide
    await renderCurrent()
  }
}

async function openPdf(): Promise<void> {
  // Open stages into the off-air preview deck; Take (Enter) promotes it to air.
  const res = await window.api.preview.openDialog()
  if (!res.ok && !res.cancelled) showBanner(`Не удалось открыть: ${res.error}`)
  if (res.ok && res.sha1Mismatch) showBanner('Заметки в sidecar-файле относятся к другому PDF. Перезаписать их.')
  if (res.ok) showBanner('Загружено в превью — Enter, чтобы выдать в эфир', 4000)
}

function showHelpModal(): void {
  document.getElementById('help-modal')?.classList.remove('hidden')
}

function hideHelpModal(): void {
  document.getElementById('help-modal')?.classList.add('hidden')
}

function showLoModal(): void {
  const modal = document.getElementById('lo-modal')
  modal?.classList.remove('hidden')
}

function hideLoModal(): void {
  const modal = document.getElementById('lo-modal')
  modal?.classList.add('hidden')
}

function showBanner(text: string, ms: number = 4000): void {
  banner.textContent = text
  banner.classList.remove('hidden')
  window.setTimeout(() => banner.classList.add('hidden'), ms)
}

// ── Custom hotkeys (operator) ──────────────────────────────────────────────
// Remappable single-key actions, persisted per-window in localStorage. The legacy
// hardware/clicker keys (PageUp/PageDown/Period) and modifier combos (Shift+T,
// Shift/Ctrl+digits) stay handled by the switch below and are NOT remappable.
interface HotkeyAction { id: string; label: string; def: string }
const HOTKEY_ACTIONS: HotkeyAction[] = [
  { id: 'take', label: 'TAKE (превью → эфир)', def: 'Tab' },
  { id: 'programNext', label: 'Эфир: следующий слайд', def: 'ArrowRight' },
  { id: 'programPrev', label: 'Эфир: предыдущий слайд', def: 'ArrowLeft' },
  { id: 'previewNext', label: 'Превью: следующий слайд', def: 'BracketRight' },
  { id: 'previewPrev', label: 'Превью: предыдущий слайд', def: 'BracketLeft' },
  { id: 'videoPlay', label: 'Видео: play / pause', def: 'Space' },
  { id: 'mute', label: 'Видео: звук вкл / выкл', def: 'KeyM' },
  { id: 'timerToggle', label: 'Таймер: старт / пауза', def: 'KeyT' },
  { id: 'blackout', label: 'Blackout', def: 'KeyB' },
]
let hotkeyMap: Record<string, string> = {}
let codeToAction: Record<string, string> = {}

function readHotkeyOverrides(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('cuedeck.hotkeys') || '{}') } catch { return {} }
}
function loadHotkeys(): void {
  const overrides = readHotkeyOverrides()
  hotkeyMap = {}
  codeToAction = {}
  for (const a of HOTKEY_ACTIONS) {
    const code = overrides[a.id] || a.def
    hotkeyMap[a.id] = code
    codeToAction[code] = a.id
  }
}
function saveHotkey(actionId: string, code: string): void {
  const o = readHotkeyOverrides()
  // Клавиша занята другим действием → отдаём ему нашу прежнюю (swap),
  // чтобы никогда не было двух действий на одной клавише.
  const prevCode = hotkeyMap[actionId]
  for (const a of HOTKEY_ACTIONS) {
    if (a.id !== actionId && hotkeyMap[a.id] === code) o[a.id] = prevCode
  }
  o[actionId] = code
  try { localStorage.setItem('cuedeck.hotkeys', JSON.stringify(o)) } catch { /* ignore */ }
  loadHotkeys()
}
function resetHotkeys(): void {
  try { localStorage.removeItem('cuedeck.hotkeys') } catch { /* ignore */ }
  loadHotkeys()
}
function keyLabel(code: string): string {
  const map: Record<string, string> = {
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', Escape: 'Esc',
    ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓',
    BracketLeft: '[', BracketRight: ']', Period: '.', Comma: ',', Slash: '/',
    PageUp: 'PgUp', PageDown: 'PgDn',
  }
  if (map[code]) return map[code]
  return code.replace(/^Key/, '').replace(/^Digit/, '')
}
function dispatchHotkey(action: string): void {
  const isVideo = getState().fileKind === 'video'
  switch (action) {
    case 'take': window.api.preview.take(); break
    case 'programNext': isVideo ? window.api.video.seekBy(5) : window.api.nav.next(); break
    case 'programPrev': isVideo ? window.api.video.seekBy(-5) : window.api.nav.prev(); break
    case 'previewNext': window.api.preview.next(); break
    case 'previewPrev': window.api.preview.prev(); break
    case 'videoPlay': isVideo ? window.api.video.toggle() : window.api.nav.next(); break
    case 'mute': if (isVideo) window.api.video.toggleMuted(); break
    case 'timerToggle': toggleTimer(); break
    case 'blackout': window.api.blackout.toggle(); break
  }
}

let capturingHotkey: { actionId: string; btn: HTMLButtonElement } | null = null
function openHotkeysModal(): void {
  const list = $('hotkeys-list')
  list.innerHTML = ''
  for (const a of HOTKEY_ACTIONS) {
    const row = document.createElement('div')
    row.className = 'hk-row'
    const lbl = document.createElement('span')
    lbl.className = 'hk-label'
    lbl.textContent = a.label
    const key = document.createElement('button')
    key.className = 'hk-key'
    key.textContent = keyLabel(hotkeyMap[a.id])
    key.addEventListener('click', () => {
      if (capturingHotkey) capturingHotkey.btn.classList.remove('capturing')
      capturingHotkey = { actionId: a.id, btn: key }
      key.textContent = 'Нажми клавишу… (Esc — отмена)'
      key.classList.add('capturing')
    })
    row.append(lbl, key)
    list.appendChild(row)
  }
  $('hotkeys-modal').classList.remove('hidden')
}
function closeHotkeysModal(): void {
  capturingHotkey = null
  $('hotkeys-modal').classList.add('hidden')
}

function setupKeyboard(): void {
  if (role !== 'operator') return
  loadHotkeys()
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
    // Remappable actions fire on a bare keypress (no modifiers); modifier combos
    // below (Shift+T, Shift/Ctrl+digits) and clicker keys fall through to the switch.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const action = codeToAction[e.code]
      if (action) {
        e.preventDefault()
        dispatchHotkey(action)
        return
      }
    }
    // e.code — физическая позиция клавиши, не зависит от языка раскладки.
    // Одиночные клавиши обрабатывает карта хоткеев выше — в switch только
    // непереназначаемое: кликерные клавиши (PageDown/PageUp/Period — их шлют
    // Logitech R400 и т.п.), Enter (легаси-Take) и комбинации с модификаторами.
    // Дублировать коды дефолтов карты здесь нельзя: иначе переназначенная
    // клавиша продолжит срабатывать по-старому.
    const isVideo = getState().fileKind === 'video'
    switch (e.code) {
      case 'PageDown':
        e.preventDefault()
        if (isVideo) window.api.video.seekBy(5)
        else window.api.nav.next()
        break
      case 'PageUp':
        e.preventDefault()
        if (isVideo) window.api.video.seekBy(-5)
        else window.api.nav.prev()
        break
      case 'Period':
        e.preventDefault()
        window.api.blackout.toggle()
        break
      case 'Enter':
        // Take: promote the staged preview deck onto the audience feed.
        e.preventDefault()
        window.api.preview.take()
        break
      case 'KeyT':
        if (e.shiftKey) {
          e.preventDefault()
          window.api.timer.reset()
        }
        break
      case 'Digit1':
      case 'Digit3':
      case 'Digit5': {
        const min = e.code === 'Digit1' ? 1 : e.code === 'Digit3' ? 3 : 5
        if (e.shiftKey) {
          e.preventDefault()
          window.api.timer.adjust(min * 60_000)
        } else if (e.ctrlKey) {
          e.preventDefault()
          window.api.timer.adjust(-min * 60_000)
        }
        break
      }
      case 'Slash':
        if (e.shiftKey) { // Shift+/ = ?
          e.preventDefault()
          showHelpModal()
        }
        break
    }
  })
}

// Drag & drop files from Finder/Explorer into the playlist (1.3). Listens on
// the whole operator window; internal playlist reorder drags carry no Files
// type and pass through untouched.
function setupFileDrop(): void {
  if (!isOperator) return
  const playlistEl = document.querySelector<HTMLElement>('.playlist')
  const isFileDrag = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes('Files'))

  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    playlistEl?.classList.add('file-drop')
  })
  window.addEventListener('dragleave', (e) => {
    // relatedTarget null → курсор покинул окно
    if (e.relatedTarget === null) playlistEl?.classList.remove('file-drop')
  })
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    playlistEl?.classList.remove('file-drop')
    const files = Array.from(e.dataTransfer?.files ?? [])
    const paths = files.map((f) => window.api.files.pathFor(f)).filter(Boolean)
    if (paths.length === 0) return
    window.api.playlist.addPaths(paths).then((added) => {
      if (added.length > 0) {
        showBanner(`В плейлист добавлено: ${added.length}`, 3000)
      } else {
        showBanner('Формат не поддерживается (PDF / PPTX / видео / изображения)', 5000)
      }
    })
  })
}

function toggleTimer(): void {
  const t = getState().timer
  if (t.running) window.api.timer.pause()
  else window.api.timer.start()
}

// Переход к слайду по номеру (1.4): Enter — перейти, Esc — сброс. Main клампит
// номер к [1, totalSlides], так что мусор безопасен.
function wireGotoInput(input: HTMLInputElement, goto: (slide: number) => void): void {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      const n = Math.floor(Number(input.value))
      if (Number.isFinite(n) && n >= 1) goto(n)
      input.value = ''
      input.blur()
    } else if (e.key === 'Escape') {
      input.value = ''
      input.blur()
    }
  })
}

function setupOperatorControls(): void {
  if (role !== 'operator') return
  $('nav-prev').addEventListener('click', () => window.api.nav.prev())
  $('nav-next').addEventListener('click', () => window.api.nav.next())
  wireGotoInput($<HTMLInputElement>('goto-input'), (n) => window.api.nav.goto(n))
  wireGotoInput($<HTMLInputElement>('preview-goto-input'), (n) => window.api.preview.goto(n))
  timerToggle.addEventListener('click', toggleTimer)
  timerReset.addEventListener('click', () => window.api.timer.reset())
  blackoutToggle.addEventListener('click', () => window.api.blackout.toggle())
  $('display-setup').addEventListener('click', openSetup)
  $('audio-setup').addEventListener('click', () => { openAudioModal().catch(() => undefined) })
  $('audio-close').addEventListener('click', () => $('audio-modal').classList.add('hidden'))

  // Duration input — debounced
  let durDebounce: number | null = null
  durationInput!.addEventListener('input', () => {
    if (durDebounce) window.clearTimeout(durDebounce)
    durDebounce = window.setTimeout(() => {
      const minutes = Math.max(0, Math.floor(Number(durationInput!.value) || 0))
      window.api.timer.setDuration(minutes * 60_000)
    }, 400)
  })

  // Presets
  document.querySelectorAll<HTMLButtonElement>('button.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const min = Number(btn.dataset.min ?? 0)
      window.api.timer.setDuration(min * 60_000)
    })
  })

  // Adjustments
  document.querySelectorAll<HTMLButtonElement>('button.adjust').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.delta ?? 0)
      window.api.timer.adjust(delta * 60_000)
    })
  })

  // Mode selector (countdown / stopwatch / clock)
  modeSelect!.addEventListener('change', () => {
    window.api.timer.setMode(modeSelect!.value as TimerMode)
  })

  // Timer scale (speaker overlay size)
  $<HTMLButtonElement>('timer-scale-down').addEventListener('click', () => {
    window.api.timer.setScale(getState().timerScale - 0.1)
  })
  $<HTMLButtonElement>('timer-scale-up').addEventListener('click', () => {
    window.api.timer.setScale(getState().timerScale + 0.1)
  })

  // Position buttons (4 corners for speaker view)
  document.querySelectorAll<HTMLButtonElement>('button.position-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos as TimerPosition | undefined
      if (pos) window.api.timer.setPosition(pos)
    })
  })

  // Notes font size
  const notesFontDown = $<HTMLButtonElement>('notes-font-down')
  const notesFontUp = $<HTMLButtonElement>('notes-font-up')
  notesFontDown.addEventListener('click', () => {
    window.api.note.setFontSize(getState().notesFontSize - 2)
  })
  notesFontUp.addEventListener('click', () => {
    window.api.note.setFontSize(getState().notesFontSize + 2)
  })

  // Playlist add button
  playlistAddBtn!.addEventListener('click', () => {
    window.api.playlist.add()
  })

  // Compact toggle
  playlistCompactToggle!.addEventListener('change', () => {
    const v = playlistCompactToggle!.checked
    playlistList?.classList.toggle('compact', v)
    window.api.playlist.setCompact(v)
  })

  // Auto-advance toggle
  playlistAutoAdvanceToggle!.addEventListener('change', () => {
    window.api.playlist.setAutoAdvance(playlistAutoAdvanceToggle!.checked)
  })

  // LibreOffice notice + install modal
  document.getElementById('lo-install-btn')?.addEventListener('click', showLoModal)
  document.getElementById('lo-modal-close')?.addEventListener('click', hideLoModal)
  document.getElementById('lo-download-btn')?.addEventListener('click', () => {
    window.api.external.open('https://www.libreoffice.org/download/download-libreoffice/')
  })
  document.getElementById('lo-copy-btn')?.addEventListener('click', (e) => {
    navigator.clipboard.writeText('brew install --cask libreoffice').catch(() => undefined)
    const btn = e.currentTarget as HTMLButtonElement
    const prev = btn.textContent
    btn.textContent = '✓'
    window.setTimeout(() => { btn.textContent = prev }, 1500)
  })

  // Video transport
  videoPlayBtn!.addEventListener('click', () => window.api.video.toggle())
  videoRestartBtn!.addEventListener('click', () => window.api.video.seek(0))
  videoMuteBtn!.addEventListener('click', () => window.api.video.toggleMuted())
  // Live label while dragging; commit the seek only on release to avoid
  // flooding every window with intermediate positions.
  videoScrub!.addEventListener('input', () => {
    if (videoTime) {
      videoTime.textContent = `${formatClock(Number(videoScrub!.value))} / ${formatClock(getState().video.durationSec)}`
    }
  })
  videoScrub!.addEventListener('change', () => {
    window.api.video.seek(Number(videoScrub!.value))
  })

  // The operator's <video> is the authority for duration + end-of-clip.
  currentVideo.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(currentVideo.duration) && currentVideo.duration > 0) {
      window.api.video.setDuration(currentVideo.duration)
    }
  })
  currentVideo.addEventListener('ended', () => {
    window.api.video.ended()
  })
  $<HTMLButtonElement>('video-error-link').addEventListener('click', () => {
    window.api.external.open('https://handbrake.fr/')
  })

  // ── Preview deck controls ────────────────────────────────────────────────
  takeBtn!.addEventListener('click', () => window.api.preview.take())
  videoTakeModeSelect!.addEventListener('change', () => {
    window.api.preview.setVideoTakeMode(videoTakeModeSelect!.value as VideoTakeMode)
  })
  previewPrevBtn!.addEventListener('click', () => window.api.preview.prev())
  previewNextBtn!.addEventListener('click', () => window.api.preview.next())
  previewVideoPlay!.addEventListener('click', () => window.api.preview.video.toggle())
  previewVideoRestart!.addEventListener('click', () => window.api.preview.video.seek(0))
  previewVideoScrub!.addEventListener('input', () => {
    if (previewVideoTime) {
      previewVideoTime.textContent = `${formatClock(Number(previewVideoScrub!.value))} / ${formatClock(getState().preview.video.durationSec)}`
    }
  })
  previewVideoScrub!.addEventListener('change', () => {
    window.api.preview.video.seek(Number(previewVideoScrub!.value))
  })
  // The operator's preview <video> is the authority for preview duration + end.
  previewVideo!.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(previewVideo!.duration) && previewVideo!.duration > 0) {
      window.api.preview.video.setDuration(previewVideo!.duration)
    }
  })
  previewVideo!.addEventListener('ended', () => window.api.preview.video.ended())
  previewVideo!.addEventListener('error', () => {
    if (getState().preview.kind !== 'video' || !previewVideo!.getAttribute('src')) return
    previewVideo!.classList.add('hidden')
    previewVideoError?.classList.remove('hidden')
  })

  // Speaker flash message: preset click = show (repeat click = снять),
  // free text via Enter, «Снять» clears.
  document.querySelectorAll<HTMLButtonElement>('button.sm-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = btn.dataset.msg ?? ''
      const active = getState().speakerMessage === msg
      window.api.speakerMessage.set(active ? null : msg)
    })
  })
  smInput!.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      window.api.speakerMessage.set(smInput!.value)
      smInput!.blur()
    } else if (e.key === 'Escape') {
      smInput!.blur()
    }
  })
  smClear!.addEventListener('click', () => {
    window.api.speakerMessage.set(null)
    if (smInput) smInput.value = ''
  })

  // Key visual
  kvSetBtn!.addEventListener('click', () => {
    window.api.keyvisual.set()
  })
  kvClearBtn!.addEventListener('click', () => {
    window.api.keyvisual.clear()
  })

  // Help button + menu
  $<HTMLButtonElement>('help-btn').addEventListener('click', showHelpModal)
  document.getElementById('help-modal-close')?.addEventListener('click', hideHelpModal)
  window.api.menu.onHelp(() => showHelpModal())

  // Hotkeys editor
  $<HTMLButtonElement>('hotkeys-btn').addEventListener('click', openHotkeysModal)
  $<HTMLButtonElement>('hotkeys-close').addEventListener('click', closeHotkeysModal)
  $<HTMLButtonElement>('hotkeys-reset').addEventListener('click', () => { resetHotkeys(); openHotkeysModal() })
  // Capture phase: intercept the next key while rebinding so it doesn't trigger an action.
  window.addEventListener('keydown', (e) => {
    if (!capturingHotkey) return
    e.preventDefault()
    e.stopPropagation()
    if (e.code !== 'Escape') saveHotkey(capturingHotkey.actionId, e.code)
    capturingHotkey = null
    openHotkeysModal()
  }, true)

  // Project menu (from macOS menubar)
  window.api.menu.onProjectNew(() => projectNew())
  window.api.menu.onProjectOpen(() => projectOpen())
  window.api.menu.onProjectSave(() => projectSave(false))
  window.api.menu.onProjectSaveAs(() => projectSave(true))

  // Update notification
  const updateBar = $('update-bar')
  const updateText = $('update-text')
  const updateDownload = $<HTMLButtonElement>('update-download')
  const updateDismiss = $<HTMLButtonElement>('update-dismiss')
  let updateUrl: string | null = null

  window.api.update.onAvailable((info) => {
    updateUrl = info.url
    updateText.textContent = `Новая версия ${info.newerVersion} доступна`
    updateBar.classList.remove('hidden')
  })
  updateDownload.addEventListener('click', () => {
    if (updateUrl) window.api.external.open(updateUrl)
  })
  updateDismiss.addEventListener('click', () => {
    updateBar.classList.add('hidden')
  })

  // Notes
  let noteDebounce: number | null = null
  notesInput.addEventListener('input', () => {
    if (noteDebounce) window.clearTimeout(noteDebounce)
    const slide = getState().currentSlide
    const text = notesInput.value
    noteDebounce = window.setTimeout(() => window.api.note.update(slide, text), 300)
  })

  // Session buttons (top-left)
  $<HTMLButtonElement>('btn-new').addEventListener('click', () => projectNew())
  $<HTMLButtonElement>('btn-open').addEventListener('click', () => projectOpen())
  $<HTMLButtonElement>('btn-save').addEventListener('click', () => projectSave(false))
  $<HTMLButtonElement>('btn-last').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('btn-last')
    btn.disabled = true
    const res = await window.api.session.restore()
    if (!res.ok && res.error) showBanner(`Ошибка: ${res.error}`, 6000)
    else if (res.sha1Mismatch) showBanner('Заметки относятся к другому PDF — возможно файл изменился.', 5000)
  })

  window.api.menu.onOpenPdf(openPdf)
  window.api.menu.onOpenDisplaySetup(openSetup)
  window.api.menu.onTopologyChanged(() => {
    showBanner('Раскладка экранов изменилась. Cmd+, для переназначения.')
  })
}

async function openSetup(): Promise<void> {
  const displays = await window.api.displays.list()
  buildSetupModal(displays)
  setupModal.classList.remove('hidden')
}

async function listAudioOutputs(): Promise<MediaDeviceInfo[]> {
  let devices = await navigator.mediaDevices.enumerateDevices()
  let outs = devices.filter((d) => d.kind === 'audiooutput')
  // Device labels stay empty until the page holds a media stream — grab the mic
  // for a moment to unlock readable names, then release it immediately.
  if (outs.length > 0 && outs.every((d) => !d.label)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      devices = await navigator.mediaDevices.enumerateDevices()
      outs = devices.filter((d) => d.kind === 'audiooutput')
    } catch {
      /* mic denied — show whatever labels we have */
    }
  }
  return outs
}

async function openAudioModal(): Promise<void> {
  const modal = $('audio-modal')
  const list = $('audio-device-list')
  list.innerHTML = '<div class="audio-loading">Поиск устройств…</div>'
  modal.classList.remove('hidden')

  const outs = await listAudioOutputs()
  const current = getState().audioOutputId
  list.innerHTML = ''

  const makeRow = (value: string | null, label: string): HTMLLabelElement => {
    const row = document.createElement('label')
    row.className = 'audio-device-row'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'audio-output'
    radio.checked = (value ?? null) === (current ?? null)
    radio.addEventListener('change', () => {
      if (radio.checked) window.api.audio.setOutput(value)
    })
    const span = document.createElement('span')
    span.textContent = label
    row.append(radio, span)
    return row
  }

  list.appendChild(makeRow(null, 'Системный выход по умолчанию'))
  for (const d of outs) {
    if (d.deviceId === 'default') continue // covered by our "default" option
    list.appendChild(makeRow(d.deviceId, d.label || `Устройство ${d.deviceId.slice(0, 6)}…`))
  }
}

function buildSetupModal(displays: DisplayInfo[]): void {
  const state = getState()
  const layoutInputs = setupModal.querySelectorAll<HTMLInputElement>('input[name="layout"]')
  const windowedToggle = $<HTMLInputElement>('audience-windowed-toggle')
  windowedToggle.checked = state.audienceWindowed

  layoutInputs.forEach((input) => {
    input.checked = input.value === state.layout
    input.onchange = () => {
      renderRoleMapping(input.value as Layout, displays, state.displayMap)
      updateWindowedSection(input.value as Layout)
    }
  })
  renderRoleMapping(state.layout, displays, state.displayMap)
  updateWindowedSection(state.layout)

  $<HTMLButtonElement>('setup-cancel').onclick = () => setupModal.classList.add('hidden')
  $<HTMLButtonElement>('setup-apply').onclick = async () => {
    const selectedLayout = Array.from(layoutInputs).find((i) => i.checked)?.value as Layout
    const mapping: DisplayMap = {}
    setupModal.querySelectorAll<HTMLSelectElement>('select[data-role]').forEach((sel) => {
      const r = sel.dataset.role as Role
      mapping[r] = Number(sel.value)
    })
    setupModal.classList.add('hidden')
    await window.api.layout.set(selectedLayout, mapping, windowedToggle.checked)
  }
}

function updateWindowedSection(layout: Layout): void {
  const section = document.getElementById('audience-windowed-section')
  if (!section) return
  section.classList.toggle('hidden', layout === 'solo')
}

function renderRoleMapping(layout: Layout, displays: DisplayInfo[], current: DisplayMap): void {
  const roles: Role[] =
    layout === 'solo'
      ? ['operator']
      : layout === 'presenter-audience'
        ? ['operator', 'audience']
        : ['operator', 'speaker', 'audience']

  const labels: Record<Role, string> = {
    operator: 'Operator (я)',
    speaker: 'Speaker (суфлёр)',
    audience: 'Audience (проектор)',
  }

  const container = $('role-mapping')
  container.innerHTML = ''
  for (const r of roles) {
    const row = document.createElement('div')
    row.className = 'row'
    const lbl = document.createElement('label')
    lbl.textContent = labels[r]
    const sel = document.createElement('select')
    sel.dataset.role = r
    for (const d of displays) {
      const opt = document.createElement('option')
      opt.value = String(d.id)
      opt.textContent = `${d.label} — ${d.bounds.width}×${d.bounds.height}`
      if (current[r] === d.id) opt.selected = true
      sel.appendChild(opt)
    }
    row.appendChild(lbl)
    row.appendChild(sel)
    container.appendChild(row)
  }
}

// OBS-style bottom bar: move notes + timer + big TAKE out of their original spots
// into #op-bottombar. Operator window only (speaker has its own DOM). Listeners
// stay attached through the move, so this can run after setupOperatorControls().
function buildOperatorBottomBar(): void {
  const bottom = $('op-bottombar')
  const notes = document.querySelector<HTMLElement>('.notes')
  const timerControlsRow = document.querySelector<HTMLElement>('.topbar-row.timer-controls')
  if (!notes || !timerControlsRow || !takeBtn) return

  // Speaker-overlay controls that still live in the top bar — move them down too.
  const scaleGroup = document.getElementById('timer-scale-down')?.closest('.group') as HTMLElement | null
  const positionGroup = document.querySelector<HTMLElement>('.position-group')

  const timerBox = document.createElement('div')
  timerBox.className = 'bottom-timer'

  // Row 1: [ 02:00  Режим▾ ] grouped on the left, transport (play/reset) on the right.
  const head = document.createElement('div')
  head.className = 'bottom-timer-head'
  const modeGroup = document.getElementById('mode-select')?.closest('.group') as HTMLElement | null
  const leftGrp = document.createElement('div')
  leftGrp.className = 'bt-head-left'
  leftGrp.append(timerDisplay)
  if (modeGroup) leftGrp.append(modeGroup)
  const transport = document.createElement('div')
  transport.className = 'bt-transport'
  transport.append(timerToggle, timerReset)
  head.append(leftGrp, transport)

  timerBox.append(head, timerControlsRow)

  // Row 3: speaker monitor size + corner (moved from the top bar).
  if (scaleGroup || positionGroup) {
    const speakerRow = document.createElement('div')
    speakerRow.className = 'bt-speaker'
    const lbl = document.createElement('span')
    lbl.className = 'bt-speaker-label'
    lbl.textContent = 'Суфлёр'
    speakerRow.append(lbl)
    if (scaleGroup) speakerRow.append(scaleGroup)
    if (positionGroup) speakerRow.append(positionGroup)
    timerBox.append(speakerRow)
  }

  takeBtn.classList.add('take-big')
  // Order: timer (left), notes, speaker message, TAKE (far right).
  // The message box is already a child of #op-bottombar (declared in HTML);
  // append() moves it into the right slot.
  bottom.append(timerBox, notes, $('speaker-msg-box'), takeBtn)
}

// Draggable splitter for the bottom bar height (persisted per-window in localStorage).
function setupBottomBarResize(): void {
  const bottom = $('op-bottombar')
  const handle = document.createElement('div')
  handle.className = 'op-bottombar-handle'
  bottom.appendChild(handle)

  const setH = (px: number): void =>
    document.documentElement.style.setProperty('--bottom-h', `${px}px`)
  try {
    const saved = Number(localStorage.getItem('cuedeck.bottomH'))
    if (saved >= 100) setH(saved)
  } catch { /* localStorage unavailable — ignore */ }

  let startY = 0
  let startH = 0
  let dragging = false
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return
    const h = Math.max(100, Math.min(window.innerHeight * 0.6, startH + (startY - e.clientY)))
    setH(h)
  }
  const onUp = (): void => {
    if (!dragging) return
    dragging = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
    const px = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-h'), 10)
    try { if (px >= 100) localStorage.setItem('cuedeck.bottomH', String(px)) } catch { /* ignore */ }
    // Pane heights changed → re-render both decks crisply.
    lastRenderedSlide = -1
    renderCurrent().catch(() => undefined)
    previewLastRenderedSlide = -1
    renderPreview().catch(() => undefined)
  }
  handle.addEventListener('mousedown', (e) => {
    dragging = true
    startY = e.clientY
    startH = bottom.getBoundingClientRect().height
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    e.preventDefault()
  })
}

async function bootstrap(): Promise<void> {
  await initBus()
  setupOperatorControls()
  setupKeyboard()
  setupFileDrop()
  if (isOperator) {
    buildOperatorBottomBar()
    setupBottomBarResize()
  }

  // Pre-check LibreOffice so the notice shows immediately if needed
  if (role === 'operator') {
    checkSoffice().then((has) => {
      if (!has) updateLibreOfficeNotice(getState())
    }).catch(() => undefined)

    // Enable "Последний" if there is a saved session
    window.api.session.hasLast().then((has) => {
      const btn = $<HTMLButtonElement>('btn-last')
      btn.disabled = !has
    }).catch(() => undefined)
  }

  subscribe((state, patch) => {
    handleStateChange(state, patch).catch((err) => showBanner(`Ошибка: ${err.message}`))
  })

  // Unsupported codec (ProRes / HEVC without OS support) → <video> fires error.
  // Operator sees the "transcode to H.264" message; other roles just stay black.
  currentVideo.addEventListener('error', () => {
    if (getState().fileKind !== 'video' || !currentVideo.getAttribute('src')) return
    currentVideo.classList.add('hidden')
    if (role === 'operator') videoError.classList.remove('hidden')
  })

  const initial = getState()
  applyState(initial)
  if (initial.pdfPath) {
    prevFilePath = initial.pdfPath
    await loadCurrentFile()
  }
  if (isOperator) {
    updatePreviewUI(initial)
    if (initial.preview.path) {
      prevPreviewPath = initial.preview.path
      await loadPreviewFile()
    }
  }

  startTick(250, () => {
    const s = getState()
    applyTimerView(timerView(s.timer, s.timerMode))
    if (s.fileKind === 'video') {
      if (!currentVideo.classList.contains('hidden')) {
        currentVideo.muted = shouldMute(s, role)
        syncVideoElement(currentVideo, s.video)
      }
      updateVideoHeader(s)
      if (role === 'operator') updateVideoUI(s)
    }
    if (isOperator) {
      const pv = s.preview
      if (pv.kind === 'video' && previewVideo && !previewVideo.classList.contains('hidden')) {
        previewVideo.muted = true
        syncVideoElement(previewVideo, pv.video)
      }
      updatePreviewUI(s)
    }
  })

  window.addEventListener('resize', () => {
    const kind = getState().fileKind
    if (kind !== 'image' && kind !== 'video' && kind !== null) {
      lastRenderedSlide = -1
      renderCurrent().catch(() => undefined)
    }
    const pk = getState().preview.kind
    if (isOperator && pk !== 'image' && pk !== 'video' && pk !== null) {
      previewLastRenderedSlide = -1
      renderPreview().catch(() => undefined)
    }
  })
}

bootstrap().catch((err) => {
  showBanner(`Не удалось запустить: ${err.message}`)
})
