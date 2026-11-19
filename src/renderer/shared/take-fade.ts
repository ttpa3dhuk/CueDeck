import { pushOffset, type PptxSlideTransition } from '../../shared/pptx-transition'
import { PdfLoader } from './animation-frame-loader'
import { FADE_MAX_MS, type TakeTransition } from '../../shared/take-transition'
import { canvasContentBox, paddingBox, type ContentBox } from './element-box'

type Source = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement
const NATIVE_FRAME_BYTES = 32 * 1024 * 1024

function sourcesHaveForeground(sources: Source[] | (() => Source[])): boolean {
  return (typeof sources === 'function' ? sources() : sources)
    .some(source => source instanceof HTMLCanvasElement && source.classList?.contains('slide-video-foreground') && !source.classList.contains('hidden'))
}

/** Keeps the outgoing picture above the deck until its replacement is ready. */
export class TakeFade {
  private nativeCache: {key:string;frames:HTMLCanvasElement[];promise:Promise<HTMLCanvasElement[]>;abort:AbortController;loader:PdfLoader} | null = null
  private nativePlaying = false
  private frame: HTMLCanvasElement | null = null
  private pushCanvas: HTMLCanvasElement | null = null
  private buildLayer: HTMLDivElement | null = null
  private animation: Animation | null = null
  private abort: AbortController | null = null
  private id: string | null = null
  private raf = 0
  private timeout: ReturnType<typeof setTimeout> | null = null
  private clips: HTMLVideoElement[] = []

  constructor(private host: HTMLElement, private sources: Source[] | (() => Source[]),
    private retainVideo?: (video: HTMLVideoElement) => HTMLVideoElement | null) {}

  active(event: TakeTransition | null | undefined): boolean {
    return Boolean(event && this.id === event.id && this.frame)
  }

  clearNative(): void {
    const old = this.nativeCache
    this.nativeCache = null
    if (!old) return
    if (this.nativePlaying) this.cancel()
    old.abort.abort()
    void old.loader.dispose()
    for (const frame of old.frames) { frame.width = 0; frame.height = 0 }
    old.frames.length = 0
  }

  /** One upcoming animation per window; preload while earlier steps are shown. */
  prepareNative(build: import('../../shared/types').SlideBuildAnimation | undefined, sha: string | null): Promise<HTMLCanvasElement[]> | null {
    if(build?.kind!=='native-frames' || !sha || !build.framesFile || !build.frameCount) { this.clearNative(); return null }
    const sources=typeof this.sources==='function'?this.sources():this.sources
    const canvas=sources.find((s):s is HTMLCanvasElement=>s instanceof HTMLCanvasElement && getComputedStyle(s).display!=='none' && s.getBoundingClientRect().width>0)
    if(!canvas) { this.clearNative(); return null }
    const width=canvasContentBox(canvas).width, key=`${sha}:${build.framesFile}:${width}`
    if(this.nativeCache?.key===key) return this.nativeCache.promise
    this.clearNative()
    const cache={key,frames:[] as HTMLCanvasElement[],promise:Promise.resolve([] as HTMLCanvasElement[]),abort:new AbortController(),loader:new PdfLoader()}
    this.nativeCache=cache
    cache.promise=(async()=>{
      const loader=cache.loader, signal=cache.abort.signal
      try {
        const bytes=await window.api.pptx.readAnimationFrames(build.framesFile!,sha)
        if(signal.aborted) return []
        if(!bytes) throw new Error('Animation PDF unavailable')
        if(!await loader.loadDocument(bytes)) return []
        if(signal.aborted) return []
        if(loader.totalPages()!==build.frameCount || build.frameCount!>31 || build.frameCount!<1) throw new Error('Animation PDF count mismatch')
        const page=await loader.getDocument()!.getPage(1), base=page.getViewport({scale:1})
        const dpr=Math.min(window.devicePixelRatio||1,2), r=build.rect
        if(![r.x,r.y,r.w,r.h].every(Number.isFinite)||r.w<=0||r.h<=0)throw new Error('Animation bounds invalid')
        // Budget the whole sequence, keeping the authored crop and timing. Only
        // oversized sequences lower raster resolution; current crops fit unchanged.
        const maxWidth=Math.max(1,Math.floor(Math.sqrt(NATIVE_FRAME_BYTES/(4*build.frameCount!*r.w*r.h*(base.height/base.width))))-4)
        const renderWidth=Math.min(width,maxWidth/dpr)
        let bytesUsed=0
        for(let page=1;page<=build.frameCount!;page++) {
          if(signal.aborted || this.nativeCache!==cache) return []
          const frame=await loader.renderRegion(page,build.rect,renderWidth,signal)
          if(frame) {
            if(signal.aborted || this.nativeCache!==cache) {frame.width=0;frame.height=0;return []}
            bytesUsed+=frame.width*frame.height*4
            if(bytesUsed>NATIVE_FRAME_BYTES){frame.width=0;frame.height=0;throw new Error('Animation raster budget exceeded')}
            cache.frames.push(frame)
          } else if(!signal.aborted) throw new Error('Animation frame unavailable')
        }
        return cache.frames
      } finally {await loader.dispose()}
    })().catch(error=>{
      if(!cache.abort.signal.aborted) console.warn('Native animation preload failed',error)
      if(this.nativeCache===cache)this.clearNative()
      return []
    })
    return cache.promise
  }

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
    const composite = sourcesHaveForeground(this.sources)
    const moving: Array<{ clip: HTMLVideoElement; rect: ContentBox; fit: string }> = []
    for (const source of typeof this.sources === 'function' ? this.sources() : this.sources) {
      const style = getComputedStyle(source)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      if (event.buildAnimation && (!(source instanceof HTMLCanvasElement) || source.classList?.contains('slide-gif'))) continue
      const bounds = source instanceof HTMLCanvasElement ? canvasContentBox(source) : source.getBoundingClientRect()
      if (!bounds.width || !bounds.height) continue
      if (event.buildAnimation) {
        const b = event.buildAnimation.rect
        const left = Math.max(0, bounds.left - rect.left + b.x * bounds.width - 2)
        const top = Math.max(0, bounds.top - rect.top + b.y * bounds.height - 2)
        const right = Math.max(0, rect.width - (bounds.left - rect.left + (b.x + b.w) * bounds.width) - 2)
        const bottom = Math.max(0, rect.height - (bounds.top - rect.top + (b.y + b.h) * bounds.height) - 2)
        frame.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`
      }
      this.draw(ctx, source, bounds, rect, getComputedStyle(source).objectFit)
      if (event.durationMs > 0 && !composite && source instanceof HTMLVideoElement && source.readyState >= 2 && !source.paused) {
        // The two media decks swap on TAKE. The old file is now served by preview.
        // Clones are always silent, so they never add a second audio route.
        if (!source.srcObject && !oldVideoInPreview && event.scope !== 'slide') continue
        const retained = this.retainVideo?.(source)
        const clip = retained ?? document.createElement('video')
        clip.muted = true
        clip.playsInline = true
        clip.loop = source.loop
        clip.style.clipPath = getComputedStyle(source).clipPath
        if (retained) { /* Keep the existing decoder and its buffered position. */ }
        else if (source.srcObject) clip.srcObject = source.srcObject
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
    this.timeout = setTimeout(() => this.cancel(), 10000 + (event.buildAnimation?.delayMs ?? 0) + (event.buildAnimation?.durationMs ?? 0))
  }

  async reveal(event: TakeTransition | null, ready: () => boolean): Promise<void> {
    if (!event || this.id !== event.id || this.animation || this.nativePlaying || !this.frame) return
    const frame = this.frame
    const signal = this.abort!.signal
    // Image decoding and the first video frame happen after the file IPC finishes.
    while (!ready()) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (signal.aborted || this.frame !== frame) return
    }
    if (signal.aborted || this.frame !== frame || this.animation) return
    const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, Math.min(event.buildAnimation || event.pushDirection || event.slideEffect ? 10000 : FADE_MAX_MS, event.durationMs)) : 0
    if (durationMs <= 0) { this.cancel(); return }
    const slideEffect = event.pushDirection
      ? { kind: 'push' as const, direction: event.pushDirection, durationMs } : event.slideEffect
    if (slideEffect && slideEffect.kind !== 'fade') {
      if (this.timeout) clearTimeout(this.timeout)
      this.timeout = null
      await this.revealSlideEffect(slideEffect, frame, durationMs, signal)
      return
    }
    if(event.buildAnimation?.kind==='native-frames') {
      this.nativePlaying=true
      const cached=this.nativeCache
      const frames=await cached?.promise
      if(signal.aborted || this.frame!==frame) return
      if(!frames?.length) {this.cancel();return}
      const host=paddingBox(this.host), sources=typeof this.sources==='function'?this.sources():this.sources
      const canvas=sources.find((s):s is HTMLCanvasElement=>s instanceof HTMLCanvasElement && getComputedStyle(s).display!=='none' && s.getBoundingClientRect().width>0)
      if(!canvas) {this.cancel();return}
      const bounds=canvasContentBox(canvas), r=event.buildAnimation.rect
      const ctx=frame.getContext('2d')!, x=bounds.left-host.left+r.x*bounds.width,y=bounds.top-host.top+r.y*bounds.height
      const start=performance.now()+(event.buildAnimation.delayMs??0)
      do {
        const progress=Math.max(0,Math.min(1,(performance.now()-start)/durationMs)), index=Math.min(frames.length-1,Math.floor(progress*(frames.length-1)))
        ctx.drawImage(frames[index],x,y,r.w*bounds.width,r.h*bounds.height)
        frame.dataset.nativeFrame=String(index)
        if(progress===1) break
        await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
      } while(!signal.aborted && this.frame===frame)
      if(this.frame===frame) this.cancel()
      return
    }
    if (event.buildAnimation?.kind && event.buildAnimation.kind !== 'fade') {
      await this.revealBuild(event, frame, durationMs)
      return
    }
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    // Keep the decoder alive briefly after its last visible frame. Releasing it
    // on the opacity boundary can stall the compositor on Windows/D3D11.
    // The visible transition still takes exactly durationMs.
    const holdMs = 200
    this.animation = frame.animate([
      { opacity: 1, offset: 0 },
      { opacity: 0, offset: durationMs / (durationMs + holdMs) },
      { opacity: 0, offset: 1 },
    ], {
      duration: durationMs + holdMs, ...(event.buildAnimation?.delayMs ? {delay:event.buildAnimation.delayMs} : {}), easing: 'linear', fill: 'forwards',
    })
    try { await this.animation.finished } catch { return }
    if (this.frame === frame) this.cancel()
  }

  private async revealSlideEffect(effect: Exclude<PptxSlideTransition, number>, outgoing: HTMLCanvasElement, duration: number, signal: AbortSignal): Promise<void> {
    if (this.pushCanvas) return
    const host = paddingBox(this.host)
    const sources = typeof this.sources === 'function' ? this.sources() : this.sources
    const reference = sources.find((source): source is HTMLCanvasElement =>
      source instanceof HTMLCanvasElement && getComputedStyle(source).display !== 'none' && source.clientWidth > 0)
    const slide = reference ? canvasContentBox(reference) : host
    const area = { x: slide.left - host.left, y: slide.top - host.top, width: slide.width, height: slide.height }
    const offset = 'direction' in effect ? pushOffset(effect.direction, area.width, area.height) : { x: 0, y: 0 }
    const canvas = document.createElement('canvas')
    canvas.className = 'take-fade-frame'
    canvas.dataset.transition = effect.kind
    canvas.width = outgoing.width
    canvas.height = outgoing.height
    this.host.append(canvas)
    this.pushCanvas = canvas
    const ctx = canvas.getContext('2d')!
    ctx.scale(canvas.width / host.width, canvas.height / host.height)
    const started = performance.now()
    do {
      const fraction = Math.min(1, (performance.now() - started) / duration)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, host.width, host.height)
      ctx.save()
      ctx.beginPath()
      ctx.rect(area.x, area.y, area.width, area.height)
      ctx.clip()
      if (effect.kind === 'fade-black' && fraction < 0.5) {
        ctx.globalAlpha = 1 - fraction * 2
        ctx.drawImage(outgoing, 0, 0, host.width, host.height)
      } else {
        if (effect.kind !== 'pull' && effect.kind !== 'fade-black') {
          const displacement = effect.kind === 'push' ? fraction : 0
          ctx.drawImage(outgoing, offset.x * displacement, offset.y * displacement, host.width, host.height)
        }
        if (effect.kind === 'push' || effect.kind === 'cover') {
          ctx.translate(offset.x * (fraction - 1), offset.y * (fraction - 1))
          ctx.beginPath()
          ctx.rect(area.x, area.y, area.width, area.height)
          ctx.clip()
        } else if (effect.kind === 'wipe') {
          const hiddenX = offset.x === 0 ? 0 : area.width * (1 - fraction)
          const hiddenY = offset.y === 0 ? 0 : area.height * (1 - fraction)
          ctx.beginPath()
          ctx.rect(area.x + (offset.x < 0 ? hiddenX : 0), area.y + (offset.y < 0 ? hiddenY : 0),
            area.width - hiddenX, area.height - hiddenY)
          ctx.clip()
        } else if (effect.kind === 'fade-black') {
          ctx.globalAlpha = fraction * 2 - 1
        }
        ctx.fillRect(area.x, area.y, area.width, area.height)
        for (const source of sources) {
          const style = getComputedStyle(source)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          const bounds = source instanceof HTMLCanvasElement ? canvasContentBox(source) : source.getBoundingClientRect()
          this.draw(ctx, source, bounds, host, style.objectFit)
        }
        if (effect.kind === 'pull') {
          ctx.beginPath()
          ctx.rect(area.x + offset.x * fraction, area.y + offset.y * fraction, area.width, area.height)
          ctx.clip()
          ctx.drawImage(outgoing, offset.x * fraction, offset.y * fraction, host.width, host.height)
        }
      }
      ctx.restore()
      canvas.dataset.progress = String(fraction)
      if (fraction === 1) break
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    } while (!signal.aborted && this.frame === outgoing)
    if (this.frame === outgoing) this.cancel()
  }

  private async revealBuild(event: TakeTransition, frame: HTMLCanvasElement, duration: number): Promise<void> {
    const build = event.buildAnimation!
    const host = paddingBox(this.host)
    const sources = typeof this.sources === 'function' ? this.sources() : this.sources
    const canvas = sources.find((s): s is HTMLCanvasElement => s instanceof HTMLCanvasElement && getComputedStyle(s).display !== 'none' && s.getBoundingClientRect().width > 0)
    if (!canvas) { this.cancel(); return }
    const bounds = canvasContentBox(canvas), r = build.rect
    const left = Math.max(0, bounds.left - host.left + r.x * bounds.width - 2)
    const top = Math.max(0, bounds.top - host.top + r.y * bounds.height - 2)
    const right = Math.max(0, host.width - (bounds.left - host.left + (r.x + r.w) * bounds.width) - 2)
    const bottom = Math.max(0, host.height - (bounds.top - host.top + (r.y + r.h) * bounds.height) - 2)
    let target: HTMLElement = frame
    let keyframes: Keyframe[]
    if (build.kind === 'fly-bottom') {
      // Only rectangular pictures are accepted by the parser. Crop their authored
      // PowerPoint pixels; moving a whole PDF page would move unrelated objects.
      const layer = document.createElement('div')
      layer.className = 'build-animation-layer'
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:7'
      layer.style.clipPath = `inset(${Math.max(0, bounds.top-host.top)}px ${Math.max(0, host.width-(bounds.right-host.left))}px ${Math.max(0, host.height-(bounds.bottom-host.top))}px ${Math.max(0, bounds.left-host.left)}px)`
      const actor = document.createElement('canvas')
      actor.width = Math.max(1, Math.ceil(r.w * canvas.width)); actor.height = Math.max(1, Math.ceil(r.h * canvas.height))
      actor.getContext('2d')!.drawImage(canvas, r.x*canvas.width, r.y*canvas.height, r.w*canvas.width, r.h*canvas.height, 0, 0, actor.width, actor.height)
      actor.style.cssText = `position:absolute;left:${bounds.left-host.left+r.x*bounds.width}px;top:${bounds.top-host.top+r.y*bounds.height}px;width:${r.w*bounds.width}px;height:${r.h*bounds.height}px;max-width:none;max-height:none`
      layer.append(actor); this.host.append(layer); this.buildLayer = layer
      target = actor
      keyframes = [{ transform: `translateY(${(1-r.y)*bounds.height}px)` }, { transform: 'translateY(0px)' }]
    } else if (build.kind === 'wipe-down') {
      keyframes = [{ clipPath: frame.style.clipPath }, { clipPath: `inset(${host.height-bottom}px ${right}px ${bottom}px ${left}px)` }]
    } else if (build.kind === 'wipe-up') {
      keyframes = [{ clipPath: frame.style.clipPath }, { clipPath: `inset(${top}px ${right}px ${host.height-top}px ${left}px)` }]
    } else if (build.kind === 'split-in-vertical') {
      const center = (left + host.width-right)/2
      keyframes = [{ clipPath: frame.style.clipPath }, { clipPath: `inset(${top}px ${host.width-center}px ${bottom}px ${center}px)` }]
    } else {
      keyframes = [{ opacity: 1 }, { opacity: 0 }]
    }
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    this.animation = target.animate(keyframes, { duration, delay: build.delayMs ?? 0, easing: 'linear', fill: 'both' })
    try { await this.animation.finished } catch { return }
    if (this.frame === frame) this.cancel()
  }

  cancel(): void {
    this.nativePlaying=false
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
    this.buildLayer?.remove()
    for (const canvas of this.buildLayer?.querySelectorAll('canvas') ?? []) { canvas.width = 0; canvas.height = 0 }
    this.buildLayer = null
    this.pushCanvas?.remove()
    if (this.pushCanvas) this.pushCanvas.width = this.pushCanvas.height = 0
    this.pushCanvas = null
    this.frame?.remove()
    if (this.frame) { this.frame.width = 0; this.frame.height = 0 }
    this.frame = null
    this.id = null
  }

  private draw(ctx: CanvasRenderingContext2D, source: Source, r: ContentBox, host: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, fit: string): void {
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
