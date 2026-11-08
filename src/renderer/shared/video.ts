import type { AppState, FileKind, Layout, Role, SlideMedia, SlideMediaRect, VideoState } from '../../preload/api'
import { syncProgramMirror } from './program-mirror'
import { FADE_MAX_MS } from '../../shared/take-transition'
import { clampVideoPosition, normalizeVideoRange, RANGE_EPSILON } from '../../shared/video-range'

export const MEDIA_SCHEME = 'cuedeck-media'

export type MediaDeck = 'program' | 'preview'

/**
 * URL the <video> element points at. The path lives in main (the active file),
 * so the URL only carries which deck to stream (program = audience feed, preview
 * = operator staging) plus a cache-buster keyed by file identity — changing the
 * latter forces the element to reload when the operator switches videos.
 */
export function videoSrc(sha1: string, deck: MediaDeck = 'program'): string {
  return `${MEDIA_SCHEME}://stream/${deck}?v=${encodeURIComponent(sha1)}`
}

/**
 * Заставка бывает картинкой и видео (анимированный KV). Расширение — самый
 * дешёвый признак: kindOf живёт в main, а рендереру нужен ответ синхронно,
 * до всякого IPC.
 */
export function isVideoPath(path: string | null | undefined): boolean {
  return Boolean(path) && /\.(mp4|m4v|mov|webm)$/i.test(path as string)
}

/**
 * Наплыв между фотографиями списка (FADE): уходящий кадр остаётся на нижнем
 * слое, новый проявляется поверх него. Через чёрное не идём — на слайдшоу это
 * читается как моргание.
 *
 * `under` — второй элемент картинки под основным; он держит старый кадр ровно
 * на время перехода. Blob-ссылку старого кадра нельзя освобождать сразу —
 * этим занимается вызывающий (см. отложенное освобождение в рендерерах).
 */
export async function crossfadeToImage(
  img: HTMLImageElement,
  under: HTMLImageElement | null,
  src: string,
  fadeMs: number,
): Promise<void> {
  fadeMs = Number.isFinite(fadeMs) ? Math.max(0, Math.min(FADE_MAX_MS, fadeMs)) : 0
  const prev = img.getAttribute('src')
  const canFade = fadeMs > 0 && Boolean(prev) && !img.classList.contains('hidden') && under

  if (!canFade) {
    img.style.transition = ''
    img.style.opacity = '1'
    img.src = src
    return
  }

  // Старый кадр — вниз, новый готовим невидимым сверху.
  under!.src = prev as string
  under!.style.opacity = '1'
  under!.classList.remove('hidden')

  img.style.transition = 'none'
  img.style.opacity = '0'
  img.src = src
  // Ждём декодирование: иначе проявится наполовину отрисованный кадр.
  await img.decode?.().catch(() => undefined)

  // Форсируем применение opacity:0 до включения перехода — иначе браузер
  // склеит оба присваивания и наплыва не будет.
  void img.offsetWidth
  img.style.transition = `opacity ${fadeMs}ms linear`
  img.style.opacity = '1'

  await new Promise((r) => setTimeout(r, fadeMs + 40))
  under!.classList.add('hidden')
  under!.removeAttribute('src')
}

/** URL видео-заставки; путь в токене — чтобы элемент перезагрузился при смене файла. */
export function keyVisualSrc(path: string): string {
  return `${MEDIA_SCHEME}://stream/keyvisual?v=${encodeURIComponent(path)}`
}

/** URL ролика, извлечённого из PPTX данного деска (слайд-видео, 2.10). */
export function slideVideoSrc(deck: MediaDeck, file: string, sha1: string): string {
  return `${MEDIA_SCHEME}://stream/slide/${deck}/${encodeURIComponent(file)}?v=${encodeURIComponent(sha1)}`
}

/** Видео на данном слайде PPTX-деска; undefined для остальных форматов. */
export function slideMediaAt(
  kind: FileKind | null,
  slideMedia: SlideMedia[],
  slide: number,
): SlideMedia | undefined {
  if (kind !== 'pptx') return undefined
  return slideMedia.find((m) => m.slide === slide && m.kind !== 'gif')
}

/**
 * Позиционирует оверлей поверх отрендеренного слайда: rect задан в долях
 * слайда, канвас — референс его экранного положения. Оверлей должен быть
 * absolutely positioned в том же offset-контейнере, что и канвас.
 */
export function slideOverlayGeometry(
  rect: SlideMediaRect,
  crop: SlideMedia['crop'],
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number; clip: number[] } {
  const left = crop?.left ?? 0, right = crop?.right ?? 0
  const top = crop?.top ?? 0, bottom = crop?.bottom ?? 0
  const visibleW = 1 - left - right, visibleH = 1 - top - bottom
  const w = rect.w * width / visibleW, h = rect.h * height / visibleH
  const x = rect.x * width - left * w, y = rect.y * height - top * h
  // Clip both to the PowerPoint picture frame and to the slide boundaries.
  const x1 = Math.max(0, rect.x * width), y1 = Math.max(0, rect.y * height)
  const x2 = Math.min(width, (rect.x + rect.w) * width)
  const y2 = Math.min(height, (rect.y + rect.h) * height)
  return { x, y, width: w, height: h,
    clip: [Math.max(0, y1 - y), Math.max(0, x + w - x2),
      Math.max(0, y + h - y2), Math.max(0, x1 - x)] }
}

export function placeSlideOverlay(
  el: HTMLElement,
  canvas: HTMLElement,
  rect: SlideMediaRect,
  crop?: SlideMedia['crop'],
): void {
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (w <= 0 || h <= 0) return
  // A constrained canvas box can be wider than its object-fit:contain image.
  // Position video over the actual PDF pixels, excluding the letterbox.
  const backing = canvas as HTMLCanvasElement
  const aspect = backing.width > 0 && backing.height > 0 ? backing.width / backing.height : w / h
  const visibleW = Math.min(w, h * aspect), visibleH = visibleW / aspect
  const g = slideOverlayGeometry(rect, crop, visibleW, visibleH)
  el.style.left = `${canvas.offsetLeft + (w - visibleW) / 2 + g.x}px`
  el.style.top = `${canvas.offsetTop + (h - visibleH) / 2 + g.y}px`
  el.style.width = `${g.width}px`
  el.style.height = `${g.height}px`
  el.style.clipPath = `inset(${g.clip.map((n) => `${n}px`).join(' ')})`
  el.style.objectFit = crop ? 'fill' : 'contain'
}

/** Position (seconds) the shared logical clock currently points at. */
/**
 * A retained <video> can keep its metadata when main resets the deck duration
 * to 0 for a duplicate/same-source activation. Report that real element
 * duration instead of waiting for an event the reused source may never emit.
 */
export function knownElementDuration(
  video: Pick<HTMLVideoElement, 'duration' | 'readyState' | 'getAttribute'>,
  expectedSrc: string,
  stateDuration: number,
): number | null {
  if (stateDuration > 0) return null
  if (video.getAttribute('src') !== expectedSrc) return null
  if (video.readyState < 1) return null
  if (!Number.isFinite(video.duration) || video.duration <= 0) return null
  return video.duration
}

export function videoPosition(v: VideoState): number {
  const raw = v.playing && v.anchorAt != null
    ? v.anchorSec + (Date.now() - v.anchorAt) / 1000
    : v.anchorSec
  return clampVideoPosition(raw, v.range, v.durationSec)
}

/**
 * Which role drives audio output: the audience (projector / program feed) when
 * present, otherwise the operator in solo. The speaker monitor is never audible.
 * Трансляция и выход OMT «Зал» в solo держат скрытое окно зала (их источник) —
 * тогда звучит оно, иначе звук эфира не попал бы в захват.
 */
export function audioRole(layout: Layout, streaming = false): Role {
  return layout === 'solo' && !streaming ? 'operator' : 'audience'
}

/**
 * A window outputs sound only if it's the audio role and the mix isn't muted.
 * Blackout is a full kill: it silences the program feed too, so a blacked-out
 * hall never keeps blasting the video's audio (playback itself keeps running —
 * un-blackout brings the sound back at the live position).
 */
export function shouldMuteMix(state: AppState, role: Role): boolean {
  return role !== audioRole(state.layout, programCaptured(state)) || state.video.muted || state.blackout || state.testScreen?.manual === true
}

/** Input mute also gates clips embedded in presentations and live input audio. */
export function shouldMute(state: AppState, role: Role): boolean {
  return shouldMuteMix(state, role) || state.sourceMuted === true
}

/**
 * Звук зала кто-то снимает: трансляция или выход OMT «Зал» со звуком. Тогда и в solo
 * звучит (скрытое) окно зала — иначе в захват попадала бы тишина.
 */
export function programCaptured(state: AppState): boolean {
  return Boolean(state.stream?.running) || (state.omt?.outputs?.program?.state === 'on' && state.omt.programAudio)
}

const DEFAULT_DRIFT_SEC = 0.4
/** Last explicit-seek token applied to each element (frame steps are sub-0.4 s). */
const appliedSeekSeq = new WeakMap<HTMLVideoElement, number>()
/** Source URL last reconciled; a new file must seek even when its token repeats. */
const appliedSource = new WeakMap<HTMLVideoElement, string>()

/**
 * Reconcile a <video> element with the shared clock: correct large drift with a
 * seek, and match the play/pause state. Small drifts are left alone so we don't
 * fight the element's native playback, EXCEPT after an explicit seek (new
 * `seekSeq`), where even one frame must reach the element.
 */
export function syncVideoElement(
  video: HTMLVideoElement,
  v: VideoState,
  driftSec: number = DEFAULT_DRIFT_SEC,
): void {
  const target = videoPosition(v)
  if (syncProgramMirror(video, v)) return
  const seq = v.seekSeq ?? 0
  const lastSeq = appliedSeekSeq.get(video)
  const source = video.currentSrc || video.src || ''
  const sourceChanged = appliedSource.get(video) !== source
  // A fresh element or a new source (same reused <video>) must land the clock
  // even if the target is only one frame away. After that, drift threshold wins.
  const forced = sourceChanged || (lastSeq !== undefined && lastSeq !== seq)
  // Retargeting an unfinished seek can repeatedly discard the decoder's work.
  // Keep play/pause responsive; reconcile the latest clock on the next tick
  // after the browser completes this seek (including manual seeks and loops).
  if (!video.seeking && Number.isFinite(target)) {
    const drift = Math.abs(video.currentTime - target)
    if (forced || drift > driftSec) {
      try {
        video.currentTime = target
        // Mark the token/source now: a browser seek is already committed to this
        // target. If it is slow, the next explicit seek gets a new token and retries.
        appliedSeekSeq.set(video, seq)
        appliedSource.set(video, source)
      } catch {
        /* element not ready yet — next tick will catch it */
      }
    } else {
      appliedSeekSeq.set(video, seq)
      appliedSource.set(video, source)
    }
  }

  const bounds = normalizeVideoRange(v.range, v.durationSec)
  // The audience/speaker windows cannot mutate the main clock. Freeze their
  // element on Out; the operator tick asks main to pause or wrap in a moment.
  if (bounds && v.playing && target >= bounds.outSec - RANGE_EPSILON) {
    if (!video.paused) video.pause()
    return
  }

  if (v.playing) {
    if (video.paused) video.play().catch(() => undefined)
  } else if (!video.paused) {
    video.pause()
  }
}

/**
 * Route a media element's sound to a specific output device (sound card,
 * minijack, HDMI to vMix…). `null`/'' → system default. Falls back to default
 * if the chosen device is gone. No-op where setSinkId isn't available.
 */
export async function applySinkId(
  el: HTMLMediaElement,
  deviceId: string | null,
): Promise<void> {
  const sinkEl = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof sinkEl.setSinkId !== 'function') return
  try {
    await sinkEl.setSinkId(deviceId ?? '')
  } catch {
    try {
      await sinkEl.setSinkId('')
    } catch {
      /* element not ready or no permission — ignore */
    }
  }
}

export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
