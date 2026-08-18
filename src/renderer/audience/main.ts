import { initBus, getState, subscribe } from '../shared/bus'
import { loadDocument, renderPageTo, prerender } from '../shared/pdf-loader'
import {
  applySinkId,
  crossfadeToImage,
  isVideoPath,
  keyVisualSrc,
  placeSlideOverlay,
  shouldMute,
  slideMediaAt,
  slideVideoSrc,
  syncVideoElement,
  videoSrc,
} from '../shared/video'
import { elementAudioStream, LiveMeter, LivePool, LiveView } from '../shared/live-stream'

/** Длительность перехода между кадрами списка; 0 — вне списка и без FADE. */
function listFadeMs(state: AppState): number {
  if (state.listIndex < 0) return 0
  const entry = state.playlist.find((e) => e.id === state.currentPlaylistId)
  return entry?.fadeMs ?? 0
}
import { liveFitFor } from '../../shared/live'
import type { AppState } from '../../preload/api'

const canvas = document.getElementById('slide-canvas') as HTMLCanvasElement
const slideImage = document.getElementById('slide-image') as HTMLImageElement
const slideVideo = document.getElementById('slide-video') as HTMLVideoElement
const liveVideo = document.getElementById('live-video') as HTMLVideoElement
const liveStatus = document.getElementById('live-status') as HTMLDivElement
const mediaOverlay = document.getElementById('media-overlay') as HTMLVideoElement
const blackout = document.getElementById('blackout') as HTMLDivElement
const kvImage = document.getElementById('keyvisual') as HTMLImageElement
const kvVideo = document.getElementById('keyvisual-video') as HTMLVideoElement
const slideImageUnder = document.getElementById('slide-image-under') as HTMLImageElement

let docLoaded = false
let lastRenderedSlide = -1
let lastFilePath: string | null = null
let lastSinkId: string | null | undefined = undefined
let slideImageBlobUrl: string | null = null
let kvBlobUrl: string | null = null
let kvLoadedForPath: string | null | undefined = undefined

/**
 * Старый кадр во время наплыва ещё показывается нижним слоем, поэтому его
 * blob-ссылку освобождаем не сразу, а после перехода. Ссылка живёт лишние
 * секунды — это дешевле, чем моргнувший кадр на экране зала.
 */
function disposeSlideImage(afterMs = 0): void {
  if (!slideImageBlobUrl) return
  const url = slideImageBlobUrl
  slideImageBlobUrl = null
  if (afterMs > 0) setTimeout(() => URL.revokeObjectURL(url), afterMs)
  else URL.revokeObjectURL(url)
}

// ── Живой вход (2.13) ────────────────────────────────────────────────────────
// Зал — озвучивающая роль во всех раскладках кроме solo (см. shouldMute в
// shared/video.ts). Звук пул тянет всегда, когда он задан у источника;
// решает, кому его слышно, muted на элементе.

let liveSinkId: string | null | undefined = undefined

// Индикатор эфирного звука у оператора: меряет тот, кто реально озвучивает.
// С немого элемента уровень не снимается (проверено спайком), а в 2–3-экранной
// раскладке немой как раз операторский — поэтому меряем здесь и шлём число.
const programMeter = new LiveMeter()

function reportProgramLevel(state: AppState): void {
  const el =
    state.fileKind === 'video'
      ? slideVideo
      : mediaOverlay.classList.contains('hidden')
        ? null
        : mediaOverlay
  programMeter.attach(el ? elementAudioStream(el) : null)
  if (programMeter.hasAudio()) window.api.meter.report(programMeter.level())
}

const livePool = new LivePool()
const liveView = new LiveView(liveVideo, livePool)

// Пул поднимает поток асинхронно (и переподключает упавший) — перерисовываем
// по его событиям, а не только по патчам состояния.
livePool.onChange(() => applyLive(getState()))

/**
 * Аудиодорожку тянем по РОЛИ окна, а не по текущему mute: mute и blackout
 * гасятся на элементе. Иначе каждое нажатие «звук выкл» пересобирало бы поток
 * с устройства — лишний захват и моргание картинки в зале.
 */
function applyLive(state: AppState): void {
  const uri = state.fileKind === 'live' ? state.pdfPath : null
  // Зал держит только то, что в эфире: постоянный «держатель» устройств —
  // окно оператора, здесь удерживать весь плейлист незачем.
  livePool.retain(uri ? [uri] : [])
  const s = liveView.show(uri)
  // Режим вписывания задан у записи плейлиста (гости приносят 4:3 и 16:10).
  liveVideo.style.objectFit = liveFitFor(state.playlist, state.currentPlaylistId, uri)
  liveStatus.classList.toggle('hidden', s.status === 'off' || s.status === 'live')
  liveStatus.textContent = s.status === 'error' ? (s.message ?? '') : ''
  liveVideo.muted = shouldMute(state, 'audience')
  if (uri) {
    // Свой счётчик выхода, отдельный от файла-видео: общий давал бы «выход уже
    // применён» при переключении файл ⇄ живой вход, и звук уходил бы не туда.
    if (state.audioOutputId !== liveSinkId) {
      liveSinkId = state.audioOutputId
      applySinkId(liveVideo, state.audioOutputId)
    }
  } else {
    liveStatus.classList.add('hidden')
  }
}

function unloadVideo(): void {
  if (slideVideo.src) {
    slideVideo.pause()
    slideVideo.removeAttribute('src')
    slideVideo.load()
  }
  slideVideo.classList.add('hidden')
}

// ── Слайд-видео из PPTX (2.10) ───────────────────────────────────────────────
// Ролик извлечён в pptx-cache при импорте; накладываем <video> поверх канваса
// по прямоугольнику плейсхолдера и ведём его тем же общим клоком state.video.

let overlaySrc: string | null = null
let overlaySinkId: string | null | undefined = undefined
// src, на котором <video> упал (кодек) — не перезаряжать его на каждом тике.
let overlayFailedSrc: string | null = null

function unloadMediaOverlay(): void {
  if (mediaOverlay.src) {
    mediaOverlay.pause()
    mediaOverlay.removeAttribute('src')
    mediaOverlay.load()
  }
  mediaOverlay.classList.add('hidden')
  overlaySrc = null
}

function updateMediaOverlay(state: AppState): void {
  const m = slideMediaAt(state.fileKind, state.slideMedia, state.currentSlide)
  if (!m || !state.pdfSha1 || canvas.classList.contains('hidden')) {
    unloadMediaOverlay()
    return
  }
  const src = slideVideoSrc('program', m.file, state.pdfSha1)
  if (src === overlayFailedSrc) {
    unloadMediaOverlay()
    return
  }
  if (overlaySrc !== src) {
    overlaySrc = src
    mediaOverlay.src = src
    mediaOverlay.load()
  }
  mediaOverlay.muted = shouldMute(state, 'audience')
  if (state.audioOutputId !== overlaySinkId) {
    overlaySinkId = state.audioOutputId
    applySinkId(mediaOverlay, state.audioOutputId)
  }
  placeSlideOverlay(mediaOverlay, canvas, m.rect)
  mediaOverlay.classList.remove('hidden')
  syncVideoElement(mediaOverlay, state.video)
}

async function loadFile(): Promise<void> {
  // Внутри списка с наплывом уходящий кадр ещё нужен нижнему слою.
  disposeSlideImage(listFadeMs(getState()) + 500)
  docLoaded = false
  lastRenderedSlide = -1
  const state = getState()

  if (state.fileKind === 'live') {
    // Поток поднимает applyLive() — здесь только убираем со сцены файловые слои.
    unloadVideo()
    canvas.classList.add('hidden')
    slideImage.classList.add('hidden')
    slideImage.removeAttribute('src')
    return
  }

  if (state.fileKind === 'video') {
    canvas.classList.add('hidden')
    slideImage.classList.add('hidden')
    slideImage.removeAttribute('src')
    slideVideo.classList.remove('hidden')
    slideVideo.muted = shouldMute(state, 'audience')
    slideVideo.src = videoSrc(state.pdfSha1 ?? '', 'program')
    slideVideo.load()
    lastSinkId = state.audioOutputId
    applySinkId(slideVideo, state.audioOutputId)
    syncVideoElement(slideVideo, state.video)
    return
  }

  unloadVideo()

  const data = await window.api.pdf.read()
  if (!data) return

  if (state.fileKind === 'image') {
    const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
    slideImageBlobUrl = URL.createObjectURL(blob)
    canvas.classList.add('hidden')
    // Фотографии списка перетекают друг в друга, если оператор задал FADE.
    await crossfadeToImage(slideImage, slideImageUnder, slideImageBlobUrl, listFadeMs(state))
    slideImage.classList.remove('hidden')
    return
  }

  // PDF
  slideImage.classList.add('hidden')
  slideImage.removeAttribute('src')
  canvas.classList.remove('hidden')
  await loadDocument(data.bytes)
  docLoaded = true
  await renderSlide()
}

async function renderSlide(): Promise<void> {
  const state = getState()
  if (state.fileKind === 'image' || state.fileKind === null) return
  if (!docLoaded) return
  if (state.currentSlide === lastRenderedSlide) return
  lastRenderedSlide = state.currentSlide
  const width = window.innerWidth
  await renderPageTo(state.currentSlide, canvas, width)
  if (state.currentSlide + 1 <= state.totalSlides) {
    prerender(state.currentSlide + 1, width).catch(() => undefined)
  }
}

async function refreshKeyVisual(state: AppState): Promise<void> {
  const path = state.keyVisualPath
  if (path === kvLoadedForPath) return
  kvLoadedForPath = path

  if (kvBlobUrl) {
    URL.revokeObjectURL(kvBlobUrl)
    kvBlobUrl = null
  }
  if (!path) {
    kvImage.removeAttribute('src')
    kvVideo.removeAttribute('src')
    kvVideo.load()
    return
  }

  // Видео-заставка (анимированный KV): не читаем файл в память, а вешаем
  // Range-поток. Элемент зациклен и нем — это фон зала, звук идёт с пульта.
  if (isVideoPath(path)) {
    kvImage.removeAttribute('src')
    kvVideo.src = keyVisualSrc(path)
    kvVideo.load()
    return
  }

  kvVideo.removeAttribute('src')
  kvVideo.load()
  const data = await window.api.keyvisual.read()
  if (!data) {
    kvImage.removeAttribute('src')
    return
  }
  const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
  kvBlobUrl = URL.createObjectURL(blob)
  kvImage.src = kvBlobUrl
}

function applyOverlay(state: AppState): void {
  const isVideoKv = isVideoPath(state.keyVisualPath)
  const showVideo = state.blackout && isVideoKv && Boolean(kvVideo.getAttribute('src'))
  const showImage = state.blackout && !isVideoKv && Boolean(state.keyVisualPath) && Boolean(kvBlobUrl)
  const showBlack = state.blackout && !showImage && !showVideo

  kvImage.classList.toggle('hidden', !showImage)
  kvVideo.classList.toggle('hidden', !showVideo)
  blackout.classList.toggle('hidden', !showBlack)

  // Играем только пока заставка на экране: скрытый ролик крутить незачем.
  // play() на display:none элементе Chromium приостанавливает (грабля 2.13),
  // поэтому порядок строгий — сначала снять hidden, потом play().
  if (showVideo) {
    if (kvVideo.paused) kvVideo.play().catch(() => undefined)
  } else if (!kvVideo.paused) {
    kvVideo.pause()
    kvVideo.currentTime = 0
  }
}

async function applyState(state: AppState): Promise<void> {
  await refreshKeyVisual(state)
  applyOverlay(state)
  applyLive(state)

  if (!state.pdfPath) {
    // Программный деск очищен (напр. «Новый проект») — гасим то, что осталось на экране.
    if (lastFilePath !== null) {
      lastFilePath = null
      docLoaded = false
      lastRenderedSlide = -1
      disposeSlideImage()
      unloadVideo()
      slideImage.classList.add('hidden')
      slideImage.removeAttribute('src')
      canvas.classList.add('hidden')
    }
  } else if (state.pdfPath !== lastFilePath) {
    lastFilePath = state.pdfPath
    await loadFile()
  } else if (state.fileKind === 'video') {
    slideVideo.muted = shouldMute(state, 'audience')
    if (state.audioOutputId !== lastSinkId) {
      lastSinkId = state.audioOutputId
      applySinkId(slideVideo, state.audioOutputId)
    }
    syncVideoElement(slideVideo, state.video)
  } else if (
    state.fileKind !== 'image' &&
    state.fileKind !== null &&
    state.currentSlide !== lastRenderedSlide
  ) {
    await renderSlide()
  }

  updateMediaOverlay(getState())
}

async function bootstrap(): Promise<void> {
  await initBus()

  // Unsupported codec → keep the projector black instead of showing a broken element.
  slideVideo.addEventListener('error', () => {
    if (getState().fileKind === 'video' && slideVideo.getAttribute('src')) {
      slideVideo.classList.add('hidden')
    }
  })
  // Слайд-видео не воспроизвелось → зал остаётся с постером из PDF.
  mediaOverlay.addEventListener('error', () => {
    if (!mediaOverlay.getAttribute('src')) return
    overlayFailedSrc = overlaySrc
    unloadMediaOverlay()
  })

  subscribe((state) => {
    applyState(state).catch(() => undefined)
  })

  const initial = getState()
  await refreshKeyVisual(initial)
  applyOverlay(initial)
  applyLive(initial)
  if (initial.pdfPath) {
    lastFilePath = initial.pdfPath
    await loadFile()
    updateMediaOverlay(getState())
  }

  // Periodically nudge the video back onto the shared clock — guards against
  // buffering/stall drift between this window and the operator's preview.
  // Уровень шлём чаще, чем идёт общий тик синхронизации: индикатор на 2 Гц
  // выглядел бы стоящим на месте.
  window.setInterval(() => reportProgramLevel(getState()), 100)

  window.setInterval(() => {
    const s = getState()
    if (s.fileKind === 'video' && !slideVideo.classList.contains('hidden')) {
      slideVideo.muted = shouldMute(s, 'audience')
      syncVideoElement(slideVideo, s.video)
    }
    if (s.fileKind === 'pptx') updateMediaOverlay(s)
  }, 500)

  window.addEventListener('resize', () => {
    const kind = getState().fileKind
    if (kind === 'image' || kind === 'video' || kind === null) return
    lastRenderedSlide = -1
    renderSlide()
      .then(() => updateMediaOverlay(getState()))
      .catch(() => undefined)
  })
}

bootstrap().catch(() => undefined)
