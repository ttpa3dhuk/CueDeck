import type { AppState, SlideInteractiveScene } from '../../shared/types'
import { slideActorAt } from '../../shared/slide-triggers'
import { PdfLoader } from './animation-frame-loader'
import { renderForegroundPair } from './slide-video-foreground'
import { placeSlideOverlay } from './video'

const fullSlide = { x: 0, y: 0, w: 1, h: 1 }

export class SlideInteractive {
  readonly layer = document.createElement('canvas')
  private request?: { key: string; abort: AbortController; base?: HTMLCanvasElement; layers: HTMLCanvasElement[]; status?: 'ready' | 'failed' }
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
    if (this.layer.width !== w || this.layer.height !== h) { this.layer.width = w; this.layer.height = h }
    const ctx = this.layer.getContext('2d')!
    ctx.drawImage(request.base, 0, 0)
    const now = Date.now()
    let moving = false
    const opacity: Record<string, number> = {}
    scene.layers.forEach((layer, index) => {
      const { effect: active, elapsed, value, playing } = slideActorAt(layer, state.slideTriggerState, now)
      moving ||= playing
      if (layer.shape) opacity[layer.shape] = Math.round(value.opacity * 1000) / 1000
      if (!value.opacity) return
      ctx.save()
      ctx.globalAlpha = value.opacity
      if (active) {
        ctx.translate(value.x * w, value.y * h)
        if (active.rotations?.length) {
          const local = elapsed % active.durationMs
          const next = active.rotations.findIndex(point => point.timeMs > local)
          if (next > 0) {
            const a = active.rotations[next - 1], b = active.rotations[next]
            const { x, y } = layer.rect
            const cx = (x + layer.rect.w / 2) * w, cy = (y + layer.rect.h / 2) * h
            ctx.translate(cx, cy)
            ctx.rotate(interpolate(a.degrees, b.degrees, (local - a.timeMs) / (b.timeMs - a.timeMs)) * Math.PI / 180)
            ctx.translate(-cx, -cy)
          }
        }
      }
      const { x, y, w: width, h: height } = layer.rect
      ctx.drawImage(request.layers[index], x * w, y * h, width * w, height * h)
      ctx.restore()
    })
    this.layer.dataset.interactive = moving ? 'playing' : 'ready'
    this.layer.dataset.actors = JSON.stringify(opacity)
    placeSlideOverlay(this.layer, this.reference, fullSlide)
    this.layer.classList.remove('hidden')
    if (moving && this.raf === undefined) this.raf = requestAnimationFrame(() => {
      this.raf = undefined
      if (this.request === request) this.refreshed()
    })
  }

  private async load(request: NonNullable<SlideInteractive['request']>, scene: SlideInteractiveScene, sha: string, width: number): Promise<void> {
    const loader = new PdfLoader()
    const { signal } = request.abort
    try {
      const bytes = await window.api.pptx.readAnimationFrames(scene.file, sha)
      if (signal.aborted) return
      if (!bytes || !await loader.loadDocument(bytes)) throw new Error('Interactive slide frames unavailable')
      const base = await loader.renderRegion(scene.firstPage, fullSlide, width, signal)
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
