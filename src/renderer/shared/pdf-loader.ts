import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

const PAGE_CACHE_MAX = 8

class OffscreenCache {
  private entries = new Map<string, HTMLCanvasElement>()

  private key(page: number, width: number): string {
    return `${page}@${width}`
  }

  get(page: number, width: number): HTMLCanvasElement | undefined {
    const k = this.key(page, width)
    const hit = this.entries.get(k)
    if (hit) {
      this.entries.delete(k)
      this.entries.set(k, hit)
    }
    return hit
  }

  set(page: number, width: number, value: HTMLCanvasElement): void {
    const k = this.key(page, width)
    if (this.entries.has(k)) this.entries.delete(k)
    this.entries.set(k, value)
    while (this.entries.size > PAGE_CACHE_MAX) {
      const firstKey = this.entries.keys().next().value
      if (firstKey !== undefined) this.entries.delete(firstKey)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

function devicePixelScale(): number {
  return Math.min(window.devicePixelRatio || 1, 2)
}

/**
 * One independent PDF document with its own page cache. The operator runs two
 * (program + preview); audience/speaker use the shared default instance via the
 * free-function exports below.
 */
export class PdfLoader {
  private cache = new OffscreenCache()
  private inflight = new Map<string, Promise<HTMLCanvasElement | null>>()
  private latestRequest = new WeakMap<HTMLCanvasElement, number>()
  private doc: PDFDocumentProxy | null = null
  private docToken = 0

  async loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
    const copy = new Uint8Array(bytes)
    const loadingTask = pdfjs.getDocument({ data: copy })
    const newDoc = await loadingTask.promise
    if (this.doc) {
      try {
        await this.doc.destroy()
      } catch {
        /* ignore */
      }
    }
    this.doc = newDoc
    this.docToken++
    this.cache.clear()
    this.inflight.clear()
    return newDoc
  }

  getDocument(): PDFDocumentProxy | null {
    return this.doc
  }

  totalPages(): number {
    return this.doc?.numPages ?? 0
  }

  private async renderToOffscreen(
    pageNum: number,
    targetWidth: number,
  ): Promise<HTMLCanvasElement | null> {
    const doc = this.doc
    if (!doc) return null
    if (pageNum < 1 || pageNum > doc.numPages) return null
    if (targetWidth <= 0) return null

    const cached = this.cache.get(pageNum, targetWidth)
    if (cached) return cached

    const key = `${pageNum}@${targetWidth}`
    const inProgress = this.inflight.get(key)
    if (inProgress) return inProgress

    const tokenAtStart = this.docToken
    const promise = (async () => {
      try {
        const page = await doc.getPage(pageNum)
        if (tokenAtStart !== this.docToken) return null

        const baseViewport = page.getViewport({ scale: 1 })
        const dpr = devicePixelScale()
        const scale = (targetWidth / baseViewport.width) * dpr
        const viewport = page.getViewport({ scale })

        const off = document.createElement('canvas')
        off.width = Math.floor(viewport.width)
        off.height = Math.floor(viewport.height)
        const ctx = off.getContext('2d')
        if (!ctx) return null

        let task: RenderTask | null = null
        try {
          task = page.render({ canvasContext: ctx, viewport })
          await task.promise
        } catch (err) {
          const name = (err as { name?: string })?.name
          if (name === 'RenderingCancelledException') return null
          throw err
        }
        if (tokenAtStart !== this.docToken) return null
        this.cache.set(pageNum, targetWidth, off)
        return off
      } finally {
        this.inflight.delete(key)
      }
    })()

    this.inflight.set(key, promise)
    return promise
  }

  async renderPageTo(
    pageNum: number,
    visibleCanvas: HTMLCanvasElement,
    targetWidth: number,
  ): Promise<void> {
    this.latestRequest.set(visibleCanvas, pageNum)
    const off = await this.renderToOffscreen(pageNum, targetWidth)
    if (!off) return
    if (this.latestRequest.get(visibleCanvas) !== pageNum) return

    const dpr = devicePixelScale()
    if (visibleCanvas.width !== off.width || visibleCanvas.height !== off.height) {
      visibleCanvas.width = off.width
      visibleCanvas.height = off.height
    }
    visibleCanvas.style.width = `${Math.floor(off.width / dpr)}px`
    visibleCanvas.style.height = `${Math.floor(off.height / dpr)}px`

    const ctx = visibleCanvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(off, 0, 0)
  }

  async prerender(pageNum: number, targetWidth: number): Promise<void> {
    await this.renderToOffscreen(pageNum, targetWidth).catch(() => null)
  }
}

// Default shared instance — backs the free-function API used by audience/speaker
// (single document) and the operator's program pane.
const defaultLoader = new PdfLoader()

export function loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return defaultLoader.loadDocument(bytes)
}

export function getDocument(): PDFDocumentProxy | null {
  return defaultLoader.getDocument()
}

export function totalPages(): number {
  return defaultLoader.totalPages()
}

export function renderPageTo(
  pageNum: number,
  visibleCanvas: HTMLCanvasElement,
  targetWidth: number,
): Promise<void> {
  return defaultLoader.renderPageTo(pageNum, visibleCanvas, targetWidth)
}

export function prerender(pageNum: number, targetWidth: number): Promise<void> {
  return defaultLoader.prerender(pageNum, targetWidth)
}
