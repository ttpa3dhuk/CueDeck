import type { AppState, FileKind, Layout, Role, SlideMedia, SlideMediaRect, VideoState } from '../../preload/api'

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
  return slideMedia.find((m) => m.slide === slide)
}

/**
 * Позиционирует оверлей поверх отрендеренного слайда: rect задан в долях
 * слайда, канвас — референс его экранного положения. Оверлей должен быть
 * absolutely positioned в том же offset-контейнере, что и канвас.
 */
export function placeSlideOverlay(
  el: HTMLElement,
  canvas: HTMLElement,
  rect: SlideMediaRect,
): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w <= 0 || h <= 0) return
  el.style.left = `${canvas.offsetLeft + rect.x * w}px`
  el.style.top = `${canvas.offsetTop + rect.y * h}px`
  el.style.width = `${rect.w * w}px`
  el.style.height = `${rect.h * h}px`
}

/** Position (seconds) the shared logical clock currently points at. */
export function videoPosition(v: VideoState): number {
  if (v.playing && v.anchorAt != null) {
    const pos = v.anchorSec + (Date.now() - v.anchorAt) / 1000
    return v.durationSec > 0 ? Math.min(pos, v.durationSec) : pos
  }
  return v.anchorSec
}

/**
 * Which role drives audio output: the audience (projector / program feed) when
 * present, otherwise the operator in solo. The speaker monitor is never audible.
 */
export function audioRole(layout: Layout): Role {
  return layout === 'solo' ? 'operator' : 'audience'
}

/**
 * A window outputs sound only if it's the audio role and the mix isn't muted.
 * Blackout is a full kill: it silences the program feed too, so a blacked-out
 * hall never keeps blasting the video's audio (playback itself keeps running —
 * un-blackout brings the sound back at the live position).
 */
export function shouldMute(state: AppState, role: Role): boolean {
  return role !== audioRole(state.layout) || state.video.muted || state.blackout
}

const DEFAULT_DRIFT_SEC = 0.4

/**
 * Reconcile a <video> element with the shared clock: correct large drift with a
 * seek, and match the play/pause state. Small drifts are left alone so we don't
 * fight the element's native playback.
 */
export function syncVideoElement(
  video: HTMLVideoElement,
  v: VideoState,
  driftSec: number = DEFAULT_DRIFT_SEC,
): void {
  const target = videoPosition(v)
  if (Number.isFinite(target) && Math.abs(video.currentTime - target) > driftSec) {
    try {
      video.currentTime = target
    } catch {
      /* element not ready yet — next tick will catch it */
    }
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
