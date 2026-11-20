import { paintComposition, sprite, invalidateComposition } from './animation-compositor'
import type { AppState, SlideInteractiveScene } from '../../shared/types'
import { slideActorAt } from '../../shared/slide-triggers'
import { AnimationFrames as PdfLoader, renderForegroundPair } from './animation-client'
import { placeSlideOverlay } from './video'

const fullSlide = { x: 0, y: 0, w: 1, h: 1 }

export class SlideInteractive {
  readonly layer = document.createElement('canvas')
  private request?: { key: string; abort: AbortController; base?: HTMLCanvasElement; layers: HTMLCanvasElement[];
    status?: 'ready' | 'failed'; lastFrame?: number; lastTriggerState?: AppState['slideTriggerState'];
    lastEnteredAt?: number; moving?: boolean }
  private raf?: number

  constructor(private reference: HTMLCanvasElement, private refreshed: () => void) {
    this.layer.className = 'slide-video-foreground hidden'
    this.layer.setAttribute('aria-hidden', 'true')
    reference.after(this.layer)
  }

  clear(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf)
    this.raf = undefined
    const request = this.request
    if (!request) return
    invalidateComposition(this.layer)
    request.abort.abort()
    for (const canvas of [request.base, ...request.layers]) if (canvas) canvas.width = canvas.height = 0
    this.request = undefined
    this.layer.width = this.layer.height = 0
    this.layer.classList.add('hidden')
    delete this.layer.dataset.interactive
    delete this.layer.dataset.actors
  }

  ready(): boolean {
    return this.request?.status === 'ready'
  }

  settled(): boolean { return this.request?.status !== undefined }

  update(scene: SlideInteractiveScene | undefined, state: AppState): void {
    if (!scene || !state.pdfSha1) { this.clear(); return }
    const width = Math.min(this.reference.clientWidth, 1280 / (window.devicePixelRatio || 1))
    if (width < 1) return
    const key = `${state.pdfSha1}:${scene.firstPage}:${width}`
    if (this.request?.key !== key) {
      this.clear()
      const request = { key, abort: new AbortController(), layers: [] as HTMLCanvasElement[] }
      this.request = request
      void this.load(request, scene, state.pdfSha1, width)
    }
    const request = this.request
    if (!request.base || request.layers.length !== scene.layers.length) return
    const { width: w, height: h } = request.base
    const items = [sprite(request.base)]
    // Two low-angle repeating objects need only 30 distinct frames per second;
    // quantizing all windows to the same clock lets the shared compositor reuse
    // one encoded frame across operator, speaker and audience.
    const fps = scene.autoEffects?.length && !scene.triggers.length ? 30 : 60
    const now = Math.floor(Date.now() / (1000 / fps)) * (1000 / fps)
    if (request.lastTriggerState === state.slideTriggerState && request.lastEnteredAt === state.slideEnteredAt &&
        (request.lastFrame === now || request.moving === false)) {
      placeSlideOverlay(this.layer, this.reference, fullSlide)
      if (request.moving) this.scheduleRefresh(request)
      return
    }
    let moving = false
    const opacity: Record<string, number> = {}
    scene.layers.forEach((layer, index) => {
      const { effect: active, elapsed, value, playing } = slideActorAt(layer, state.slideTriggerState, now,
        scene.autoEffects, state.slideEnteredAt)
      moving ||= playing
      if (layer.shape) opacity[layer.shape] = Math.round(value.opacity * 1000) / 1000
      if (!value.opacity) return
      const matrix = new DOMMatrix()
      if (active) {
        matrix.translateSelf(value.x * w, value.y * h)
        if (active.rotations?.length) {
          const local = elapsed % active.durationMs
          const next = active.rotations.findIndex(point => point.timeMs > local)
          if (next > 0) {
            const a = active.rotations[next - 1], b = active.rotations[next]
            const cx = (layer.pivot?.x ?? layer.rect.x + layer.rect.w / 2) * w
            const cy = (layer.pivot?.y ?? layer.rect.y + layer.rect.h / 2) * h
            matrix.translateSelf(cx, cy)
            matrix.rotateSelf(interpolate(a.degrees, b.degrees, (local - a.timeMs) / (b.timeMs - a.timeMs)))
            matrix.scaleSelf(value.scale)
            matrix.translateSelf(-cx, -cy)
          }
        } else if (value.scale !== 1) {
          const cx = (layer.pivot?.x ?? layer.rect.x + layer.rect.w / 2) * w
          const cy = (layer.pivot?.y ?? layer.rect.y + layer.rect.h / 2) * h
          matrix.translateSelf(cx, cy)
          matrix.scaleSelf(value.scale)
          matrix.translateSelf(-cx, -cy)
        }
      }
      const { x, y, w: width, h: height } = layer.rect
      items.push(sprite(request.layers[index],value.opacity,[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f],[x*w,y*h,width*w,height*h]))
    })
    paintComposition(this.layer,w,h,items)
    request.lastFrame = now
    request.lastTriggerState = state.slideTriggerState
    request.lastEnteredAt = state.slideEnteredAt
    request.moving = moving
    this.layer.dataset.interactive = moving ? 'playing' : 'ready'
    this.layer.dataset.actors = JSON.stringify(opacity)
    placeSlideOverlay(this.layer, this.reference, fullSlide)
    this.layer.classList.remove('hidden')
    if (moving) this.scheduleRefresh(request)
  }

  private scheduleRefresh(request: NonNullable<SlideInteractive['request']>): void {
    if (this.raf !== undefined) return
    this.raf = requestAnimationFrame(() => {
      this.raf = undefined
      if (this.request === request) this.refreshed()
    })
  }

  private async load(request: NonNullable<SlideInteractive['request']>, scene: SlideInteractiveScene, sha: string, width: number): Promise<void> {
    const loader = new PdfLoader()
    const { signal } = request.abort
    try {
      if (!await loader.open(scene.file, sha, signal)) return
      const base = await loader.renderRegion(scene.firstPage, fullSlide, loader.shared ? 1280 : width, signal)
      if (signal.aborted) { if (base) base.width = base.height = 0; return }
      if (!base) throw new Error('Interactive slide background unavailable')
      request.base = base
      for (const descriptor of scene.layers) {
        const layer = await renderForegroundPair(loader, descriptor.page, width, signal, descriptor.rect)
        if (signal.aborted) { if (layer) layer.width = layer.height = 0; return }
        if (!layer) throw new Error('Interactive slide layer unavailable')
        request.layers.push(layer)
      }
      request.status = 'ready'
    } catch (error) {
      request.status = 'failed'
      if (!signal.aborted) console.warn('Interactive slide unavailable', error)
    } finally {
      void loader.dispose()
      if (!signal.aborted) this.refreshed()
    }
  }
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}
