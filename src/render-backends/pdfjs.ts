import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { OwnedSlideFrame, SlideFrameBackend, SlideFrameKey } from '../../packages/render-core/src/frame-source'
import type { RenderBackendInfo, RenderDocumentInfo } from '../../packages/render-core/src/kernel'

export interface PdfFrameDocument {
  /** Immutable source revision; never reuse an ID after changing file contents. */
  id: string
  size: number
  open(): Promise<PDFDocumentProxy>
}
export interface RgbaSlideFrame extends OwnedSlideFrame {
  readonly pixels: Uint8ClampedArray
}

/** One PDF.js document/worker per revision, shared by all pages and consumers.
 * Caller must use one SlideFrameSource so renders/cleanup stay serialized. */
export class PdfFrameBackend implements SlideFrameBackend<RgbaSlideFrame> {
  readonly info: RenderBackendInfo = { apiVersion: 1, id: 'pdfjs', formats: ['rgba8'] }
  private documents = new Map<string, Promise<PDFDocumentProxy>>()
  private sources: Map<string, PdfFrameDocument>
  private stopped = false
  private geometry = new Map<string, { width: number; height: number }>()
  private decoded: { document: string; page: number; proxy: PDFPageProxy } | null = null
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null
  readonly stats = { opened: 0, rasterized: 0, decodedReused: 0, recent: [] as { key: SlideFrameKey; at: number }[] }

  private releaseDecoded(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    this.cleanupTimer = null
    this.decoded?.proxy.cleanup()
    this.decoded = null
  }

  constructor(sources: PdfFrameDocument[], private createCanvas = (): HTMLCanvasElement => document.createElement('canvas')) {
    if (sources.length > 2 || new Set(sources.map(s => s.id)).size !== sources.length ||
      sources.some(s => !s.id || !Number.isSafeInteger(s.size) || s.size < 0)) {
      throw new Error('Prototype supports at most two distinct immutable PDF revisions')
    }
    this.sources = new Map(sources.map(source => [source.id, { ...source }]))
  }

  private async document(id: string): Promise<PDFDocumentProxy> {
    if (this.stopped) throw new Error('PDF frame request cancelled')
    const source = this.sources.get(id)
    if (!source) throw new Error('Unknown PDF revision')
    let loading = this.documents.get(id)
    if (!loading) {
      loading = Promise.resolve().then(() => source.open())
      this.documents.set(id, loading)
      this.stats.opened++
      void loading.catch(() => { if (this.documents.get(id) === loading) this.documents.delete(id) })
    }
    const doc = await loading
    if (this.stopped || this.sources.get(id) !== source) throw new Error('PDF revision was retired')
    return doc
  }

  addSource(source: PdfFrameDocument): void {
    if (this.stopped || this.sources.has(source.id) || this.sources.size >= 2) throw new Error('Invalid PDF source registration')
    this.sources.set(source.id, { ...source })
  }

  async retire(id: string): Promise<void> {
    if (this.decoded?.document === id) this.releaseDecoded()
    this.sources.delete(id)
    const pending = this.documents.get(id)
    this.documents.delete(id)
    for (const key of this.geometry.keys()) if (key.startsWith(`${id}:`)) this.geometry.delete(key)
    if (pending) {
      let doc: PDFDocumentProxy
      try { doc = await pending } catch { return }
      await doc.destroy()
    }
  }

  async pageInfo(id: string, page: number): Promise<{ width: number; height: number }> {
    if (!Number.isInteger(page) || page < 1) throw new Error('Invalid PDF page')
    const key = `${id}:${page}`
    const hit = this.geometry.get(key)
    if (hit) return hit
    const source = this.sources.get(id)
    const doc = await this.document(id)
    if (page > doc.numPages) throw new Error('PDF page out of range')
    const proxy = await doc.getPage(page)
    if (this.sources.get(id) !== source) throw new Error('PDF revision was retired')
    const { width, height } = proxy.getViewport({ scale: 1 })
    const info = { width, height }
    this.geometry.set(key, info)
    return info
  }

  async describe(id: string): Promise<RenderDocumentInfo> {
    const doc = await this.document(id)
    if (this.stopped) throw new Error('PDF frame request cancelled')
    return { id, pages: doc.numPages }
  }

  async render(key: SlideFrameKey, signal: AbortSignal): Promise<RgbaSlideFrame> {
    if (key.timeUs !== undefined) throw new Error('PDF backend supports static frames only')
    const source = this.sources.get(key.document)
    const check = (): void => {
      if (this.stopped || signal.aborted || this.sources.get(key.document) !== source) throw new Error('PDF frame request cancelled')
    }
    check()
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    this.cleanupTimer = null
    if (this.decoded && (this.decoded.document !== key.document || this.decoded.page !== key.page)) this.releaseDecoded()
    else if (this.decoded) this.stats.decodedReused++
    const doc = await this.document(key.document)
    if (!source) throw new Error('Unknown PDF revision')
    check()
    if (key.page > doc.numPages) throw new Error('PDF page out of range')
    const page = await doc.getPage(key.page)
    let canvas: HTMLCanvasElement | null = null
    let completed = false
    try {
      check()
      const rotation = (page.rotate + key.rotation) % 360
      const base = page.getViewport({ scale: 1, rotation })
      const widthScale = key.width / base.width
      const scale = Math.floor(base.height * widthScale) <= key.height ? widthScale : Math.min(widthScale, key.height / base.height)
      const viewport = page.getViewport({ scale, rotation })
      canvas = this.createCanvas()
      const width = Math.min(key.width, Math.max(1, Math.floor(viewport.width)))
      const height = Math.min(key.height, Math.max(1, Math.floor(viewport.height)))
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D unavailable')
      // PDF.js owns the entire context state. An outer save/clip caused blank
      // or partial image-heavy pages in Chromium. Compose letterbox pixels later.
      const task = page.render({ canvasContext: context, viewport })
      // An obsolete visible request must drain an already-started PDF page.
      // RenderTask.cancel rejects before its worker has stopped decoding; feeding
      // another page immediately recreates the backlog fixed in test.5.
      // Owner shutdown destroys its loading tasks/worker explicitly instead.
      await task.promise
      check()
      this.stats.rasterized++
      this.stats.recent.push({ key: { ...key }, at: Date.now() })
      if (this.stats.recent.length > 32) this.stats.recent.shift()
      // Own completed CPU pixels before releasing any decoded PDF resources.
      const raw = context.getImageData(0, 0, width, height).data
      let pixels = raw
      if (width !== key.width || height !== key.height) {
        pixels = new Uint8ClampedArray(key.width * key.height * 4)
        for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255
        const left = Math.floor((key.width - width) / 2), top = Math.floor((key.height - height) / 2)
        for (let row = 0; row < height; row++) {
          pixels.set(raw.subarray(row * width * 4, (row + 1) * width * 4), ((row + top) * key.width + left) * 4)
        }
      }
      completed = true
      return { get pixels() { return pixels }, byteLength: pixels.byteLength,
        close: () => { pixels = new Uint8ClampedArray() } }
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0 }
      // A page can be requested at several output sizes. Reuse its decode for
      // that burst, without keeping multiple huge pages or an idle decode alive.
      if (source.size >= 256 * 1024 * 1024) {
        if (completed) {
          this.decoded = { document: key.document, page: key.page, proxy: page }
          this.cleanupTimer = setTimeout(() => this.releaseDecoded(), 300)
        } else {
          if (this.decoded?.proxy === page) this.releaseDecoded()
          else page.cleanup()
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.releaseDecoded()
    const documents = [...this.documents.values()]
    this.documents.clear()
    await Promise.all(documents.map(async loading => {
      let doc: PDFDocumentProxy
      try { doc = await loading } catch { return }
      await doc.destroy()
    }))
  }
}
