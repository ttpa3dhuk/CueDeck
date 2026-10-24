import type { TakeTransition } from '../../shared/take-transition'
import { paddingBox } from './element-box'

type Source = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement

/** Keeps the outgoing picture above the deck until its replacement is ready. */
export class TakeFade {
  private frame: HTMLCanvasElement | null = null
  private animation: Animation | null = null
  private abort: AbortController | null = null
  private id: string | null = null
  private raf = 0
  private timeout: ReturnType<typeof setTimeout> | null = null
  private clips: HTMLVideoElement[] = []

  constructor(private host: HTMLElement, private sources: Source[]) {}

  begin(event: TakeTransition | null, oldVideoInPreview = false): void {
    // Slide cuts still need a readiness barrier: load() clears the outgoing
    // video frame before the next decoder has produced its first picture.
    if (!event || (event.durationMs <= 0 && event.scope !== 'slide')) { this.cancel(); return }
    // The frame occupies the padding box, excluding the visible deck border.
    const rect = paddingBox(this.host)
    if (!rect.width || !rect.height) { this.cancel(); return }
    const frame = document.createElement('canvas')
    frame.width = Math.ceil(rect.width * devicePixelRatio)
    frame.height = Math.ceil(rect.height * devicePixelRatio)
    frame.className = 'take-fade-frame'
    const ctx = frame.getContext('2d')!
    ctx.scale(devicePixelRatio, devicePixelRatio)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, rect.width, rect.height)
    const moving: Array<{ clip: HTMLVideoElement; rect: DOMRect; fit: string }> = []
    for (const source of this.sources) {
      if (getComputedStyle(source).display === 'none') continue
      const bounds = source.getBoundingClientRect()
      if (!bounds.width || !bounds.height) continue
      this.draw(ctx, source, bounds, rect, getComputedStyle(source).objectFit)
      if (event.durationMs > 0 && source instanceof HTMLVideoElement && source.readyState >= 2 && !source.paused) {
        // The two media decks swap on TAKE. The old file is now served by preview.
        // Clones are always silent, so they never add a second audio route.
        if (!source.srcObject && !oldVideoInPreview && event.scope !== 'slide') continue
        const clip = document.createElement('video')
        clip.muted = true
        clip.playsInline = true
        clip.loop = source.loop
        clip.style.clipPath = getComputedStyle(source).clipPath
        if (source.srcObject) clip.srcObject = source.srcObject
        else {
          clip.src = event.scope === 'slide' ? source.src : source.src.replace('://stream/program?', '://stream/preview?')
            .replace('://stream/slide/program/', '://stream/slide/preview/')
          const position = source.currentTime
          clip.addEventListener('loadedmetadata', () => { clip.currentTime = position }, { once: true })
        }
        moving.push({ clip, rect: bounds, fit: getComputedStyle(source).objectFit })
        void clip.play().catch(() => undefined)
      }
    }
    // Repeated Fade starts from the picture currently being seen, not an older frame.
    if (this.frame) {
      ctx.globalAlpha = Number(getComputedStyle(this.frame).opacity)
      ctx.drawImage(this.frame, 0, 0, rect.width, rect.height)
      ctx.globalAlpha = 1
    }
    this.cancel()
    this.id = event.id
    this.abort = new AbortController()
    this.frame = frame
    this.clips = moving.map((m) => m.clip)
    this.host.append(frame)
    for (const clip of this.clips) {
      clip.style.cssText += ';position:absolute;width:1px;height:1px;opacity:0;pointer-events:none'
      this.host.append(clip)
    }
    if (moving.length) {
      const tick = (): void => {
        for (const m of moving) this.draw(ctx, m.clip, m.rect, rect, m.fit)
        this.raf = requestAnimationFrame(tick)
      }
      this.raf = requestAnimationFrame(tick)
    }
    // A failed read/decoder must not leave the outgoing picture stuck indefinitely.
    this.timeout = setTimeout(() => this.cancel(), 10000)
  }

  async reveal(event: TakeTransition | null, ready: () => boolean): Promise<void> {
    if (!event || this.id !== event.id || this.animation || !this.frame) return
    const frame = this.frame
    const signal = this.abort!.signal
    // Image decoding and the first video frame happen after the file IPC finishes.
    while (!ready()) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (signal.aborted || this.frame !== frame) return
    }
    if (signal.aborted || this.frame !== frame || this.animation) return
    if (event.durationMs <= 0) { this.cancel(); return }
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    this.animation = frame.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: event.durationMs, easing: 'linear', fill: 'forwards',
    })
    try { await this.animation.finished } catch { return }
    if (this.frame === frame) this.cancel()
  }

  cancel(): void {
    this.abort?.abort()
    this.abort = null
    this.animation?.cancel()
    this.animation = null
    cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    for (const clip of this.clips) {
      clip.pause()
      clip.srcObject = null
      clip.removeAttribute('src')
      clip.load()
      clip.remove()
    }
    this.clips = []
    this.frame?.remove()
    this.frame = null
    this.id = null
  }

  private draw(ctx: CanvasRenderingContext2D, source: Source, r: DOMRect, host: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, fit: string): void {
    const w = source instanceof HTMLVideoElement ? source.videoWidth
      : source instanceof HTMLImageElement ? source.naturalWidth : source.width
    const h = source instanceof HTMLVideoElement ? source.videoHeight
      : source instanceof HTMLImageElement ? source.naturalHeight : source.height
    if (!w || !h) return
    const x = r.left - host.left, y = r.top - host.top
    const scale = fit === 'cover' ? Math.max(r.width / w, r.height / h) : Math.min(r.width / w, r.height / h)
    const dw = fit === 'fill' ? r.width : w * scale
    const dh = fit === 'fill' ? r.height : h * scale
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, r.width, r.height)
    ctx.clip()
    // The PPTX video can extend beyond its cropped picture frame. Preserve
    // its CSS clipping in the outgoing snapshot as well as the live overlay.
    const inset = getComputedStyle(source).clipPath.match(/^inset\(([^)]+)\)$/)
    if (inset) {
      const values = inset[1].split(/\s+/).map((v) => Number.parseFloat(v))
      if (values.length >= 1 && values.length <= 4 && values.every(Number.isFinite)) {
        const top = values[0], right = values[1] ?? top
        const bottom = values[2] ?? top, left = values[3] ?? right
        ctx.beginPath()
        ctx.rect(x + left, y + top, Math.max(0, r.width - left - right), Math.max(0, r.height - top - bottom))
        ctx.clip()
      }
    }
    try { ctx.drawImage(source, x + (r.width - dw) / 2, y + (r.height - dh) / 2, dw, dh) } catch { /* No decoded frame yet. */ }
    ctx.restore()
  }
}
