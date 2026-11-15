import { FramePortClient, type FramePort } from '../../../packages/render-core/src/frame-port'
import type { PdfFileSource } from '../../shared/pdf-source'
import type { SharedPdfInfo } from '../../shared/pdf-frames'
import type { PdfLoader as LegacyLoader } from './pdf-loader'
import { fitPdfPage, pdfRasterSize } from '../../shared/pdf-frame-geometry'
import { paddingBox } from './element-box'

interface Pane {
  id: string
  canvas: HTMLCanvasElement | null
  serial: number
  paintSerial: number
  version: number
  cssWidth: number
  cssHeight: number
  page: { width: number; height: number }
  client: FramePortClient | null
  opening: Promise<FramePortClient> | null
}
const ports = new Map<string, { resolve(port: MessagePort): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
const loaders = new Set<PdfLoader>()
let loaderSerial = 0
let connectionSerial = 0

window.addEventListener('message', event => {
  if (event.source !== window) return
  if (event.data?.type === 'cuedeck-pdf-port' && event.ports[0]) {
    const id = event.data.metadata?.requestId
    const pending = ports.get(id)
    if (!pending) { event.ports[0].close(); return }
    ports.delete(id); clearTimeout(pending.timer); pending.resolve(event.ports[0])
  }
  if (event.data?.type === 'cuedeck-pdf-reset') {
    if (event.data.metadata?.state === 'lost') {
      for (const pending of ports.values()) { clearTimeout(pending.timer); pending.reject(new Error('PDF owner restarted')) }
      ports.clear()
      for (const loader of loaders) loader.resetTransport()
    } else if (event.data.metadata?.state === 'available') window.dispatchEvent(new Event('cuedeck-pdf-recovered'))
  }
})

async function openPort(id: string): Promise<MessagePort> {
  const requestId = `${id}-${++connectionSerial}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ports.delete(requestId); reject(new Error('PDF frame port timed out')) }, 120000)
    ports.set(requestId, { resolve, reject, timer })
    void window.api.pdfFrames.connect(requestId, id).catch(error => {
      if (ports.delete(requestId)) { clearTimeout(timer); reject(error) }
    })
  })
}

/** UI owns only display pixels. Legacy PDF.js is dynamically imported solely
 * for the explicit troubleshooting mode or old non-shared file descriptors. */
export class PdfLoader {
  private id = `pdf-${++loaderSerial}`
  private source: PdfFileSource | null = null
  private version = 0
  private pages = 0
  private legacy: LegacyLoader | null = null
  private geometry = new Map<number, Promise<SharedPdfInfo>>()
  private canvases = new WeakMap<HTMLCanvasElement, Pane>()
  private panes = new Set<Pane>()
  private prefetch: Pane | null = null
  private programCanvas: HTMLCanvasElement | null = null
  private programWidth = 0

  constructor() { loaders.add(this) }
  clearDocument(): void {
    this.version++; this.source = null; this.pages = 0; this.geometry.clear()
    for (const pane of this.panes) { pane.serial++; pane.client?.cancel(); pane.opening = null }
  }
  resetTransport(): void {
    this.version++; this.geometry.clear()
    for (const pane of this.panes) {
      pane.serial++; pane.client?.close(); pane.client = null; pane.opening = null
    }
  }
  async loadDocument(data: Uint8Array | PdfFileSource): Promise<{ numPages: number } | null> {
    this.clearDocument()
    const version = this.version
    try {
      if (!(data instanceof Uint8Array) && data.shared) {
        if (!window.api.pdfFrames) throw new Error('PDF frame API is unavailable; restart CueDeck')
        this.source = { ...data }
        await this.legacy?.getDocument()?.destroy()
        const info = await window.api.pdfFrames.describe(data.shared.id)
        if (version !== this.version) return null
        this.pages = info.pages
        return { numPages: this.pages }
      }
      if (!this.legacy) this.legacy = new (await import('./pdf-loader')).PdfLoader()
      const doc = await this.legacy.loadDocument(data)
      if (version !== this.version) { if (this.source) await doc?.destroy(); return null }
      this.pages = doc?.numPages ?? 0
      return doc
    } catch (error) { if (version !== this.version) return null; throw error }
  }
  totalPages(): number { return this.pages }
  getDocument(): { numPages: number } | null { return this.pages ? { numPages: this.pages } : null }

  private makePane(canvas: HTMLCanvasElement | null): Pane {
    const pane: Pane = { id: `${this.id}-p${this.panes.size + 1}`, canvas, serial: 0, paintSerial: 0,
      version: 0, cssWidth: 0, cssHeight: 0, page: { width: 1, height: 1 }, client: null, opening: null }
    this.panes.add(pane)
    if (canvas) this.canvases.set(canvas, pane)
    return pane
  }
  private async client(pane: Pane): Promise<FramePortClient> {
    if (pane.client) return pane.client
    if (pane.opening) return pane.opening
    const version = this.version
    const opening = openPort(pane.id).then(port => {
      if (version !== this.version) { port.close(); throw new Error('Obsolete PDF frame port') }
      const client = new FramePortClient(port as unknown as FramePort, (buffer, key) => {
        const canvas = pane.canvas
        if (!canvas || pane.version !== this.version || pane.serial !== pane.paintSerial ||
          this.source?.shared?.id !== key.document) return
        if (canvas.width !== key.width || canvas.height !== key.height) { canvas.width = key.width; canvas.height = key.height }
        // Layout can change while pixels are in flight. Fit at commit time,
        // rather than flashing the old request's CSS size before ResizeObserver.
        const box = canvas.parentElement ? paddingBox(canvas.parentElement) : null
        const css = box && box.width > 0 && box.height > 0 ? fitPdfPage(pane.page, box) : { width: pane.cssWidth, height: pane.cssHeight }
        canvas.style.width = `${css.width}px`; canvas.style.height = `${css.height}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('PDF display canvas is unavailable')
        ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), key.width, key.height), 0, 0)
      })
      pane.client = client
      return client
    }).finally(() => { if (pane.opening === opening) pane.opening = null })
    pane.opening = opening
    return opening
  }
  private pageInfo(page: number): Promise<SharedPdfInfo> {
    let pending = this.geometry.get(page)
    if (!pending) {
      pending = window.api.pdfFrames.describe(this.source!.shared!.id, page)
      this.geometry.set(page, pending)
      void pending.catch(() => { if (this.geometry.get(page) === pending) this.geometry.delete(page) })
    }
    return pending
  }
  private async request(page: number, pane: Pane, targetWidth: number, targetHeight: number, prefetch: boolean): Promise<void> {
    if (!this.source?.shared || !Number.isFinite(targetWidth) || targetWidth <= 0 || page < 1 || page > this.pages) return
    const version = this.version, serial = ++pane.serial, document = this.source.shared.id
    const stale = () => version !== this.version || serial !== pane.serial || this.source?.shared?.id !== document
    try {
      const info = await this.pageInfo(page)
      if (stale()) return
      if (!info.width || !info.height || !Number.isFinite(info.width / info.height)) throw new Error('Invalid PDF page geometry')
      const geometry = { width: info.width, height: info.height }
      const { width, height } = pdfRasterSize(geometry, info.raster ?? { width: 1920, height: 1080 })
      const css = fitPdfPage(geometry, { width: targetWidth, height: targetHeight > 0 ? targetHeight : Infinity })
      pane.page = geometry; pane.cssWidth = css.width; pane.cssHeight = css.height
      pane.version = version; pane.paintSerial = serial
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = await this.client(pane)
        const deadline = Date.now() + 120000
        while (!client.documents.some(doc => doc.id === document)) {
          if (stale()) return
          if (Date.now() > deadline) throw new Error('PDF owner did not register the document')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        if (stale()) return
        const next = pane.canvas !== this.programCanvas
        const painted = await client.request({ document, page, width, height, rotation: 0 }, prefetch ? 'prefetch' : next ? 'preview' : 'program', !prefetch, prefetch || next)
        if (painted || stale()) return
        client.close(); pane.client = null
      }
      throw new Error('PDF frame could not be displayed')
    } catch (error) { if (!stale()) throw error }
  }
  async renderPageTo(page: number, canvas: HTMLCanvasElement, width: number, height = Infinity): Promise<void> {
    if (!this.source?.shared) { await this.legacy?.renderPageTo(page, canvas, width, height); return }
    const pane = this.canvases.get(canvas) ?? this.makePane(canvas)
    this.programCanvas ??= canvas
    if (canvas === this.programCanvas) this.programWidth = width
    // Operator layouts can hide Next while keeping PGM visible. Still prepare
    // its PGM raster, without sending pixels to a hidden thumbnail.
    if (width <= 0 && canvas !== this.programCanvas) {
      await this.request(page, pane, this.programWidth, Infinity, true)
      return
    }
    // PGM, Next and every other view use the same output-resolution key.
    // Card/window resizing changes display geometry only.
    await this.request(page, pane, width, height, false)
  }
  async prerender(page: number, width: number): Promise<void> {
    if (!this.source?.shared) { await this.legacy?.prerender(page, width); return }
    const pane = this.prefetch ??= this.makePane(null)
    await this.request(page, pane, width, Infinity, true)
  }
}

const defaultLoader = new PdfLoader()
export const loadDocument = (data: Uint8Array | PdfFileSource) => defaultLoader.loadDocument(data)
export const clearDocument = () => defaultLoader.clearDocument()
export const totalPages = () => defaultLoader.totalPages()
export const renderPageTo = (page: number, canvas: HTMLCanvasElement, width: number, height = Infinity) => defaultLoader.renderPageTo(page, canvas, width, height)
export const prerender = (page: number, width: number) => defaultLoader.prerender(page, width)
