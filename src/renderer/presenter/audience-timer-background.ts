import type { AppState } from '../../preload/api'
import { getState } from '../shared/bus'
import { isVideoPath, slideMediaAt, slideOverlayGeometry, slideVideoSrc } from '../shared/video'

type Picture = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement

/** Clean program picture, without the operator's transport or a duplicate timer. */
export class AudienceTimerBackground {
  size = { width: 1920, height: 1080 }
  private lastSize = 0
  private sizing = false
  private keyPath: string | null | undefined
  private keyPicture: HTMLImageElement | HTMLVideoElement | null = null
  private keyUrl: string | null = null

  constructor(private canvas: HTMLCanvasElement, private stage: HTMLElement) {
    new ResizeObserver(() => this.render()).observe(stage)
    window.setInterval(() => this.render(), 100)
  }

  private dimensions(source: Picture): [number, number] {
    return source instanceof HTMLVideoElement ? [source.videoWidth, source.videoHeight]
      : source instanceof HTMLImageElement ? [source.naturalWidth, source.naturalHeight] : [source.width, source.height]
  }

  private draw(ctx: CanvasRenderingContext2D, source: Picture | null, box: { x: number; y: number; width: number; height: number }, fit = 'contain'): void {
    if (!source) return
    const [w, h] = this.dimensions(source)
    if (!w || !h) return
    const scale = fit === 'cover' ? Math.max(box.width / w, box.height / h) : Math.min(box.width / w, box.height / h)
    const width = fit === 'fill' ? box.width : w * scale, height = fit === 'fill' ? box.height : h * scale
    ctx.save()
    ctx.beginPath(); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip()
    try { ctx.drawImage(source, box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height) } catch { /* Decoder has not produced a frame yet. */ }
    ctx.restore()
  }

  private async loadKeyVisual(state: AppState): Promise<void> {
    const path = state.keyVisualPath
    if (path === this.keyPath) return
    this.keyPath = path
    if (this.keyPicture instanceof HTMLVideoElement) { this.keyPicture.pause(); this.keyPicture.removeAttribute('src'); this.keyPicture.load() }
    this.keyPicture = null
    if (this.keyUrl) URL.revokeObjectURL(this.keyUrl)
    this.keyUrl = null
    if (!path) return
    if (isVideoPath(path)) {
      const video = document.createElement('video')
      video.muted = true; video.loop = true; video.playsInline = true
      video.src = `cuedeck-media://stream/keyvisual?v=${encodeURIComponent(path)}`
      this.keyPicture = video
      return
    }
    const data = await window.api.keyvisual.read().catch(() => null)
    if (!data || this.keyPath !== path) return
    this.keyUrl = URL.createObjectURL(new Blob([data.bytes as BlobPart], { type: data.mime }))
    const image = new Image(); image.src = this.keyUrl
    this.keyPicture = image
  }

  render(): void {
    if (!this.stage.getClientRects().length) {
      if (this.keyPicture instanceof HTMLVideoElement) this.keyPicture.pause()
      return
    }
    if (!this.sizing && Date.now() - this.lastSize > 500) {
      this.sizing = true
      void window.api.monitor.audienceSize().then(size => {
        if (size.width > 0 && size.height > 0) {
          this.size = size
          this.stage.style.aspectRatio = `${size.width} / ${size.height}`
        }
      }).catch(() => undefined).finally(() => { this.sizing = false; this.lastSize = Date.now() })
    }
    const width = this.stage.clientWidth, height = this.stage.clientHeight
    if (!width || !height) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    if (this.canvas.width !== Math.round(width * dpr)) this.canvas.width = Math.round(width * dpr)
    if (this.canvas.height !== Math.round(height * dpr)) this.canvas.height = Math.round(height * dpr)
    const ctx = this.canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height)
    const state = getState()
    const box = { x: 0, y: 0, width, height }
    if (state.blackout) {
      void this.loadKeyVisual(state)
      if (this.keyPicture instanceof HTMLVideoElement && this.keyPicture.paused) void this.keyPicture.play().catch(() => undefined)
      this.draw(ctx, this.keyPicture, box)
      return
    }
    if (this.keyPicture instanceof HTMLVideoElement) this.keyPicture.pause()
    const sourceId = state.fileKind === 'video' ? 'current-video' : state.fileKind === 'live' ? 'current-live'
      : state.fileKind === 'image' ? 'current-image' : 'current-canvas'
    const source = document.getElementById(sourceId) as Picture
    this.draw(ctx, source, box, getComputedStyle(source).objectFit || 'contain')
    const media = slideMediaAt(state.fileKind, state.slideMedia, state.currentSlide)
    const overlay = document.getElementById('media-overlay') as HTMLVideoElement
    if (!media || !state.pdfSha1 || overlay.src !== slideVideoSrc('program', media.file, state.pdfSha1) || overlay.readyState < 2) return
    const [w, h] = this.dimensions(source)
    if (!w || !h) return
    const scale = Math.min(width / w, height / h), slideW = w * scale, slideH = h * scale
    const left = (width - slideW) / 2, top = (height - slideH) / 2
    const g = slideOverlayGeometry(media.rect, media.crop, slideW, slideH)
    ctx.save()
    ctx.beginPath(); ctx.rect(left + g.x + g.clip[3], top + g.y + g.clip[0], g.width - g.clip[1] - g.clip[3], g.height - g.clip[0] - g.clip[2]); ctx.clip()
    ctx.fillStyle = '#000'; ctx.fillRect(left + g.x, top + g.y, g.width, g.height)
    this.draw(ctx, overlay, { x: left + g.x, y: top + g.y, width: g.width, height: g.height }, media.crop ? 'fill' : 'contain')
    ctx.restore()
  }
}
