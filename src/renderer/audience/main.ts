import { SlideInteractive } from '../shared/slide-interactive'
import { SlideVisitedLinks, visitedLinkCrops } from '../shared/slide-visited-links'
import { shouldReloadProgramDocument } from '../shared/program-document-reload'
import { SlideAudio } from '../shared/slide-audio'
import { SlideVideoForeground } from '../shared/slide-video-foreground'
import { rejectAudioOnlyVideo } from '../shared/video-content'
import { SlideGifs } from '../shared/slide-gifs'
import { configureProgramMirror, loadProgramVideo, releaseProgramVideo, programVideoCanvas, programVideoReady } from '../shared/program-mirror'
import { setupTestScreen } from '../shared/test-screen-controller'
import { ProgramTimerAudio } from '../shared/program-timer-audio'
import { TakeFade } from '../shared/take-fade'
import { SlidePaintTracker, overlayFrameReady } from '../shared/slide-paint'
import { initBus, getState, subscribe } from '../shared/bus'
import { AudienceTimerView } from '../shared/audience-timer-view'
import { loadDocument, clearDocument, renderPageTo, prerender } from '../shared/pdf-frame-client'
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
  return state.takeTransition?.durationMs ? 0 : entry?.fadeMs ?? 0
}
import { liveFitFor } from '../../shared/live'
import { WINDOW_TITLES } from '../../shared/window-titles'
import type { AppState } from '../../preload/api'

document.title = WINDOW_TITLES.audience

const canvas = document.getElementById('slide-canvas') as HTMLCanvasElement
const slideGifs = new SlideGifs(canvas, 'program')
const slideImage = document.getElementById('slide-image') as HTMLImageElement
let slideVideo = document.getElementById('slide-video') as HTMLVideoElement
const liveVideo = document.getElementById('live-video') as HTMLVideoElement
const liveStatus = document.getElementById('live-status') as HTMLDivElement
let mediaOverlay = document.getElementById('media-overlay') as HTMLVideoElement
const videoForeground = new SlideVideoForeground(canvas, mediaOverlay, false, () => updateMediaOverlay(getState()))
const slideAudio = new SlideAudio()
const slideInteractive = new SlideInteractive(canvas, () => updateMediaOverlay(getState()))
const slideVisitedLinks = new SlideVisitedLinks(canvas, () => updateMediaOverlay(getState()))
const blackout = document.getElementById('blackout') as HTMLDivElement
const kvImage = document.getElementById('keyvisual') as HTMLImageElement
const kvVideo = document.getElementById('keyvisual-video') as HTMLVideoElement
const slideImageUnder = document.getElementById('slide-image-under') as HTMLImageElement

const takeFade = new TakeFade(document.body, () => [slideImageUnder, canvas, slideImage, slideVideo, programVideoCanvas(slideVideo), liveVideo, mediaOverlay, programVideoCanvas(mediaOverlay), videoForeground.layer, slideInteractive.layer, slideVisitedLinks.layer, ...slideGifs.elements()], retainAudienceVideo)

function retainAudienceVideo(video: HTMLVideoElement): HTMLVideoElement | null {
  if (video !== slideVideo && video !== mediaOverlay || slideAudio.output.has(video)) return null
  const replacement = video.cloneNode(false) as HTMLVideoElement
  replacement.removeAttribute('src')
  releaseProgramVideo(video)
  programVideoCanvas(video).remove()
  video.replaceWith(replacement)
  video.removeAttribute('id')
  if (video === slideVideo) {
    slideVideo = replacement
    lastFilePath = null
    lastSinkId = undefined
  } else {
    mediaOverlay = replacement
    overlaySrc = null
    overlaySlide = -1
    overlaySinkId = undefined
  }
  bindAudienceVideo(replacement)
  return video
}

function bindAudienceVideo(video: HTMLVideoElement): void {
  rejectAudioOnlyVideo(video, () => {
    if (video === slideVideo || video === mediaOverlay) void window.api.video.pause()
  })
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return
    if (video === slideVideo && getState().fileKind === 'video') {
      window.api.diag.log('error', 'Program video failed', mediaErrorInfo(video))
      video.classList.add('hidden')
    } else if (video === mediaOverlay) {
      window.api.diag.log('error', 'Slide video failed', mediaErrorInfo(video))
      overlayFailedSrc = overlaySrc
      unloadMediaOverlay()
    }
  })
}
const slidePaint = new SlidePaintTracker()

function programFrameReady(): boolean {
  const s = getState()
  if (s.fileKind === 'video') return programVideoReady(slideVideo)
  if (s.fileKind === 'live') return liveVideo.readyState >= 2
  if (s.fileKind === 'image') return slideImage.complete && slideImage.naturalWidth > 0
  if (!docLoaded || slidePaint.pending || lastRenderedSlide !== s.currentSlide) return false
  if (!slideGifs.ready() || s.slideMedia.some(media => media.slide === s.currentSlide && media.interactive) && !slideInteractive.settled() ||
    visitedLinkCrops(s, s.currentSlide).length > 0 && !slideVisitedLinks.settled()) return false
  const media = slideMediaAt(s.fileKind, s.slideMedia, s.currentSlide)
  if (!media || !s.pdfSha1) return true
  const expected = slideVideoSrc('program', media.file, s.pdfSha1)
  return overlayFailedSrc === expected || (overlaySlide === s.currentSlide &&
    !mediaOverlay.classList.contains('slide-video-wait-foreground') &&
    overlayFrameReady(expected, overlaySrc, overlayFailedSrc, programVideoReady(mediaOverlay) ? 2 : 0, false))
}

let programLoadGeneration = 0
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
  liveView.configureAudio(liveVideo.muted, state.audioOutputId)
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
  releaseProgramVideo(slideVideo)
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
let overlaySlide = -1
let overlayAnchorAt: number | null = null
let overlaySinkId: string | null | undefined = undefined
// src, на котором <video> упал (кодек) — не перезаряжать его на каждом тике.
let overlayFailedSrc: string | null = null

function unloadMediaOverlay(clearAudio = true): void {
  if (clearAudio) { slideAudio.clear(); slideInteractive.clear() }
  videoForeground.clear()
  mediaOverlay.classList.remove('slide-video-wait-foreground')
  programVideoCanvas(mediaOverlay).classList.remove('slide-video-wait-foreground')
  releaseProgramVideo(mediaOverlay)
  if (mediaOverlay.src) {
    mediaOverlay.pause()
    mediaOverlay.removeAttribute('src')
    mediaOverlay.load()
  }
  mediaOverlay.classList.add('hidden')
  overlaySrc = null
  overlaySlide = -1
}

function updateMediaOverlay(state: AppState): void {
  const restarting = overlayAnchorAt !== state.video.anchorAt && state.video.playing &&
    state.video.anchorSec === 0 && mediaOverlay.currentTime > 0.35
  const leaving = overlaySlide >= 0 && (state.fileKind !== 'pptx' || overlaySlide !== state.currentSlide || restarting)
  if (leaving && slideAudio.output.holdForSwitch(mediaOverlay, () => updateMediaOverlay(getState()))) return
  slideAudio.updateTransition(state, 'audience')
  slideGifs.update(state.fileKind, state.slideMedia, state.currentSlide, state.pdfSha1,
    docLoaded && !slidePaint.pending && lastRenderedSlide === state.currentSlide)
  if (state.fileKind === 'pptx' && (!docLoaded || slidePaint.pending || lastRenderedSlide !== state.currentSlide)) {
    slideInteractive.clear()
    slideVisitedLinks.clear()
    slideAudio.clear()
    videoForeground.clear()
    mediaOverlay.muted = true
    mediaOverlay.pause()
    return
  }
  const interactive = state.fileKind === 'pptx' ? state.slideMedia.find(media => media.slide === state.currentSlide && media.interactive)?.interactive : undefined
  slideInteractive.update(interactive, state)
  slideVisitedLinks.update(state)
  const soundMedia = state.fileKind === 'pptx' ? state.slideMedia.find(media => media.slide === state.currentSlide && media.audio?.length) : undefined
  slideAudio.update(soundMedia, state, 'audience')
  const m = slideMediaAt(state.fileKind, state.slideMedia, state.currentSlide)
  if (!m || !state.pdfSha1 || canvas.classList.contains('hidden')) {
    unloadMediaOverlay(false)
    return
  }
  const src = slideVideoSrc('program', m.file, state.pdfSha1)
  if (src === overlayFailedSrc) {
    unloadMediaOverlay(false)
    return
  }
  overlaySlide = state.currentSlide
  overlayAnchorAt = state.video.anchorAt
  if (overlaySrc !== src) {
    overlaySrc = src
    loadProgramVideo(mediaOverlay, src)
  }
  mediaOverlay.volume = m.volume ?? 1
  placeSlideOverlay(mediaOverlay, canvas, m.rect, m.crop)
  const foregroundReady = videoForeground.update(m, state.pdfSha1, Boolean(state.slideMenuOpen), state.video.anchorAt, state.slideMenuOpenedAt, takeFade.active(state.takeTransition), state.takeTransition?.durationMs ?? 0)
  mediaOverlay.classList.toggle('slide-video-wait-foreground', !foregroundReady)
  programVideoCanvas(mediaOverlay).classList.toggle('slide-video-wait-foreground', !foregroundReady)
  mediaOverlay.classList.remove('hidden')
  syncVideoElement(mediaOverlay, state.video)
  const muted = shouldMute(state, 'audience')
  const routed = slideAudio.output.configure(mediaOverlay, muted, state.audioOutputId)
  mediaOverlay.muted = muted
  if (!routed && overlaySinkId !== state.audioOutputId) {
    overlaySinkId = state.audioOutputId
    if (state.audioOutputId) void applySinkId(mediaOverlay, state.audioOutputId)
    else if (mediaOverlay.sinkId) void applySinkId(mediaOverlay, null)
  }
}

async function loadFile(): Promise<void> {
  takeFade.clearNative()
  clearDocument()
  // Внутри списка с наплывом уходящий кадр ещё нужен нижнему слою.
  disposeSlideImage(listFadeMs(getState()) + 500)
  docLoaded = false
  lastRenderedSlide = -1
  const generation = ++programLoadGeneration
  const state = getState()
  const stale = (): boolean => generation !== programLoadGeneration || getState().pdfPath !== state.pdfPath
  const t0 = performance.now()
  // В журнал: сколько зал грузил файл до первого кадра — по этим цифрам ищем
  // промаргивание/задержки (diag.ts).
  const done = (what: string): void =>
    window.api.diag.log('info', `${what} за ${Math.round(performance.now() - t0)} мс`)

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
    loadProgramVideo(slideVideo, videoSrc(state.pdfSha1 ?? '', 'program'))
    lastSinkId = state.audioOutputId
    applySinkId(slideVideo, state.audioOutputId)
    syncVideoElement(slideVideo, state.video)
    done('видео подвешено') // i18n-ok: журнал
    return
  }

  unloadVideo()

  const data = await window.api.pdf.read()
  if (stale()) return
  if (!data) {
    window.api.diag.log('warn', `pdf:read вернул null для ${state.fileKind} ${state.pdfPath}`)
    return
  }

  if (state.fileKind === 'image') {
    const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
    slideImageBlobUrl = URL.createObjectURL(blob)
    canvas.classList.add('hidden')
    // Фотографии списка перетекают друг в друга, если оператор задал FADE.
    await crossfadeToImage(slideImage, slideImageUnder, slideImageBlobUrl, listFadeMs(state))
    if (stale()) return
    slideImage.classList.remove('hidden')
    done('картинка показана') // i18n-ok: журнал
    return
  }

  // PDF
  slideImage.classList.add('hidden')
  slideImage.removeAttribute('src')
  canvas.classList.remove('hidden')
  if (!await loadDocument(data.pdf ?? data.bytes)) return
  if (stale()) return
  docLoaded = true
  await renderSlide()
  done(`${state.fileKind} открыт (${Math.round((data.pdf?.size ?? data.bytes.byteLength) / 1024)} КБ), первый слайд отрисован`) // i18n-ok: журнал
}

async function renderSlide(): Promise<void> {
  const state = getState()
  if (state.fileKind === 'image' || state.fileKind === null) return
  if (!docLoaded) return
  if (state.currentSlide === lastRenderedSlide && !slidePaint.pending) return
  const slide = state.currentSlide
  const path = state.pdfPath
  const generation = programLoadGeneration
  const width = window.innerWidth
  const t0 = performance.now()
  const request = slidePaint.begin()
  await renderPageTo(slide, canvas, width)
  if (generation !== programLoadGeneration || !docLoaded || getState().pdfPath !== path || getState().currentSlide !== slide) return
  if (!slidePaint.finish(request)) return
  lastRenderedSlide = slide
  const upcoming = Object.entries(state.slideBuilds ?? {}).filter(([page, build]) => Number(page) >= slide && Number(page) <= slide + 1 && build.kind === 'native-frames').sort((a,b)=>Number(a[0])-Number(b[0]))[0]?.[1]
  void takeFade.prepareNative(upcoming, state.pdfSha1)
  window.api.diag.log('info', `слайд ${state.currentSlide} отрисован за ${Math.round(performance.now() - t0)} мс`)
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

async function applyState(state: AppState, patch: Partial<AppState> | null): Promise<void> {
  await refreshKeyVisual(state)
  applyOverlay(state)
  applyLive(state)

  if (!state.pdfPath) {
    // Программный деск очищен (напр. «Новый проект») — гасим то, что осталось на экране.
    if (lastFilePath !== null) {
      lastFilePath = null
      docLoaded = false
      clearDocument()
      takeFade.clearNative()
      lastRenderedSlide = -1
      disposeSlideImage()
      unloadVideo()
      slideImage.classList.add('hidden')
      slideImage.removeAttribute('src')
      canvas.classList.add('hidden')
    }
  } else if (shouldReloadProgramDocument(lastFilePath, state, patch)) {
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
    (state.currentSlide !== lastRenderedSlide || slidePaint.pending)
  ) {
    await renderSlide()
  }

  updateMediaOverlay(getState())
}

async function bootstrap(): Promise<void> {
  await initBus()
  await configureProgramMirror('audience', getState)
  setupTestScreen(document.body, 'audience')
  const programTimerAudio = new ProgramTimerAudio('audience')
  setInterval(() => programTimerAudio.update(getState()), 100)
  new AudienceTimerView(document.getElementById('audience-timer')!, document.body,
    () => ({ timer: getState().audienceTimer, covered: getState().blackout }))

  bindAudienceVideo(slideVideo)
  bindAudienceVideo(mediaOverlay)

  subscribe((state, patch) => {
    if (patch && Object.hasOwn(patch, 'takeTransition')) {
      takeFade.begin(patch.takeTransition ?? null, state.preview.path === lastFilePath)
    } else if (!state.pdfPath || (patch && Object.hasOwn(patch, 'currentSlide'))) {
      takeFade.cancel()
    }
    const contentChanged = patch && (Object.hasOwn(patch, 'takeTransition') || Object.hasOwn(patch, 'pdfPath'))
    applyState(state, patch).then(() => {
      if (contentChanged) void takeFade.reveal(state.takeTransition, programFrameReady).then(() => updateMediaOverlay(getState()))
    }).catch((err) => window.api.diag.log('error', 'applyState упал', String(err?.stack ?? err)))
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

  window.addEventListener('cuedeck-pdf-recovered', () => {
    const kind = getState().fileKind
    if (kind === 'pdf' || kind === 'pptx') void loadFile().catch(error => window.api.diag.log('error', 'PDF recovery failed', String(error)))
  })
  window.addEventListener('resize', () => {
    const kind = getState().fileKind
    if (kind === 'image' || kind === 'video' || kind === null) return
    lastRenderedSlide = -1
    renderSlide()
      .then(() => updateMediaOverlay(getState()))
      .catch(() => undefined)
  })
}

/** Код и текст MediaError — без них «видео не играет» в журнале бесполезно. */
function mediaErrorInfo(el: HTMLVideoElement): { code: number | null; message: string | null } {
  return { code: el.error?.code ?? null, message: el.error?.message ?? null }
}

bootstrap().catch((err) => window.api.diag.log('error', 'bootstrap зала упал', String(err?.stack ?? err)))
