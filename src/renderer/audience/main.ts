import { initBus, getState, subscribe } from '../shared/bus'
import { loadDocument, renderPageTo, prerender } from '../shared/pdf-loader'
import {
  applySinkId,
  placeSlideOverlay,
  shouldMute,
  slideMediaAt,
  slideVideoSrc,
  syncVideoElement,
  videoSrc,
} from '../shared/video'
import type { AppState } from '../../preload/api'

const canvas = document.getElementById('slide-canvas') as HTMLCanvasElement
const slideImage = document.getElementById('slide-image') as HTMLImageElement
const slideVideo = document.getElementById('slide-video') as HTMLVideoElement
const mediaOverlay = document.getElementById('media-overlay') as HTMLVideoElement
const blackout = document.getElementById('blackout') as HTMLDivElement
const kvImage = document.getElementById('keyvisual') as HTMLImageElement

let docLoaded = false
let lastRenderedSlide = -1
let lastFilePath: string | null = null
let lastSinkId: string | null | undefined = undefined
let slideImageBlobUrl: string | null = null
let kvBlobUrl: string | null = null
let kvLoadedForPath: string | null | undefined = undefined

function disposeSlideImage(): void {
  if (slideImageBlobUrl) {
    URL.revokeObjectURL(slideImageBlobUrl)
    slideImageBlobUrl = null
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
  disposeSlideImage()
  docLoaded = false
  lastRenderedSlide = -1
  const state = getState()

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
    slideImage.src = slideImageBlobUrl
    slideImage.classList.remove('hidden')
    canvas.classList.add('hidden')
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
    return
  }
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
  const showImage = state.blackout && Boolean(state.keyVisualPath) && Boolean(kvBlobUrl)
  const showBlack = state.blackout && !showImage
  kvImage.classList.toggle('hidden', !showImage)
  blackout.classList.toggle('hidden', !showBlack)
}

async function applyState(state: AppState): Promise<void> {
  await refreshKeyVisual(state)
  applyOverlay(state)

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
  if (initial.pdfPath) {
    lastFilePath = initial.pdfPath
    await loadFile()
    updateMediaOverlay(getState())
  }

  // Periodically nudge the video back onto the shared clock — guards against
  // buffering/stall drift between this window and the operator's preview.
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
