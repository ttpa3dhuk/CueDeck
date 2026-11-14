import { pdfImageDecoderOption } from './pdf-image-decoder'
import { LocalPdfRangeTransport } from './pdf-range-transport'
import type { PdfFileSource } from '../../shared/pdf-source'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

const PAGE_CACHE_MAX = 8
// Large documents already reserve a full-length buffer in each PDF.js worker.
// Trade decoded-page reuse for memory headroom only in these documents.
const EAGER_PAGE_CLEANUP_BYTES = 256 * 1024 * 1024

interface RenderJob {
  promise: Promise<HTMLCanvasElement | null>
  task: RenderTask | null
  users: number
  cancelled: boolean
}

interface RenderLease {
  promise: Promise<HTMLCanvasElement | null>
  release(): void
}

class OffscreenCache {
  private entries = new Map<string, HTMLCanvasElement>()

  get(k: string): HTMLCanvasElement | undefined {
    const hit = this.entries.get(k)
    if (hit) {
      this.entries.delete(k)
      this.entries.set(k, hit)
    }
    return hit
  }

  set(k: string, value: HTMLCanvasElement): void {
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
  private inflight = new Map<string, RenderJob>()
  private latestRequest = new WeakMap<HTMLCanvasElement, RenderLease>()
  private preload: RenderLease | null = null
  private renderTail: Promise<unknown> = Promise.resolve()
  private doc: PDFDocumentProxy | null = null
  private loadingTask: PDFDocumentLoadingTask | null = null
  private docToken = 0
  private loadRequest = 0
  private eagerPageCleanup = false

  async loadDocument(bytes: Uint8Array | PdfFileSource): Promise<PDFDocumentProxy | null> {
    const request = ++this.loadRequest
    // Invalidate pending paints before awaiting the new PDF, even if it fails.
    const previous = this.doc
    const pending = this.loadingTask
    this.loadingTask = null
    void pending?.destroy().catch(() => undefined)
    this.doc = null
    this.docToken++
    this.preload?.release()
    this.preload = null
    for (const job of this.inflight.values()) {
      job.cancelled = true
      job.task?.cancel()
    }
    this.inflight.clear()
    this.cache.clear()
    const retired = previous?.destroy().catch(() => undefined)
    const range = bytes instanceof Uint8Array ? null : new LocalPdfRangeTransport(bytes)
    this.eagerPageCleanup = (bytes instanceof Uint8Array ? bytes.byteLength : bytes.size) >= EAGER_PAGE_CLEANUP_BYTES
    const isImageDecoderSupported = pdfImageDecoderOption(
      globalThis.navigator?.userAgent ?? '',
      typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function',
    )
    const loadingTask = pdfjs.getDocument(range
      ? { isImageDecoderSupported, range, length: (bytes as PdfFileSource).size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 1024 * 1024 }
      : { isImageDecoderSupported, data: new Uint8Array(bytes as Uint8Array) })
    this.loadingTask = loadingTask
    // Errors after the document header has loaded must also reject pending
    // page renders, rather than leave them waiting for ranges indefinitely.
    void range?.failure.catch(() => { void loadingTask.destroy().catch(() => undefined) })
    let newDoc: PDFDocumentProxy
    try {
      newDoc = await (range ? Promise.race([loadingTask.promise, range.failure]) : loadingTask.promise)
    } catch (error) {
      range?.abort()
      await loadingTask.destroy?.().catch(() => undefined)
      if (request !== this.loadRequest) return null
      throw error
    } finally {
      if (this.loadingTask === loadingTask) this.loadingTask = null
    }
    await retired
    if (request !== this.loadRequest) {
      await newDoc.destroy().catch(() => undefined)
      return null
    }
    this.doc = newDoc
    return newDoc
  }

  getDocument(): PDFDocumentProxy | null {
    return this.doc
  }

  totalPages(): number {
    return this.doc?.numPages ?? 0
  }

  private acquirePage(pageNum: number, targetWidth: number): RenderLease {
    const empty = (): RenderLease => ({ promise: Promise.resolve(null), release() {} })
    const doc = this.doc
    if (!doc || pageNum < 1 || pageNum > doc.numPages || !Number.isFinite(targetWidth) || targetWidth <= 0) return empty()

    const dpr = devicePixelScale()
    const key = `${pageNum}@${targetWidth}@${dpr}`
    const cached = this.cache.get(key)
    if (cached) return { promise: Promise.resolve(cached), release() {} }
    let job = this.inflight.get(key)
    if (!job) {
      const tokenAtStart = this.docToken
      const eagerPageCleanup = this.eagerPageCleanup
      const created: RenderJob = { promise: Promise.resolve(null), task: null, users: 0, cancelled: false }
      job = created
      this.inflight.set(key, created)
      // Feed PDF.js one page at a time. Cancelling a RenderTask alone rejects
      // its promise before the worker stops parsing/decoding that page; starting
      // every intermediate slide still floods the worker during fast navigation.
      // Obsolete waiting jobs are skipped before getPage/render are called.
      created.promise = this.renderTail.then(async () => {
        let off: HTMLCanvasElement | null = null
        let page: PDFPageProxy | null = null
        let retained = false
        try {
          if (tokenAtStart !== this.docToken || created.cancelled) return null
          page = await doc.getPage(pageNum)
          if (tokenAtStart !== this.docToken || created.cancelled) return null

          const baseViewport = page.getViewport({ scale: 1 })
          const viewport = page.getViewport({ scale: (targetWidth / baseViewport.width) * dpr })
          off = document.createElement('canvas')
          off.width = Math.floor(viewport.width)
          off.height = Math.floor(viewport.height)
          const ctx = off.getContext('2d')
          if (!ctx) return null

          created.task = page.render({ canvasContext: ctx, viewport })
          await created.task.promise
          if (tokenAtStart !== this.docToken || created.cancelled) return null
          this.cache.set(key, off)
          retained = true
          return off
        } catch (err) {
          if (created.cancelled || tokenAtStart !== this.docToken || (err as { name?: string })?.name === 'RenderingCancelledException') return null
          throw err
        } finally {
          // The completed raster is ours. Release PDF.js' full-resolution
          // image bitmaps/operator list now, instead of its delayed cleanup
          // retaining several enormous scanned pages in every output window.
          if (eagerPageCleanup) page?.cleanup()
          // An older cancelled job must not remove a new request for the same page.
          if (this.inflight.get(key) === created) this.inflight.delete(key)
          created.task = null
          if (off && !retained) { off.width = 0; off.height = 0 }
        }
      })
      this.renderTail = created.promise.catch(() => null)
    }

    const owned = job
    owned.users++
    let released = false
    return {
      promise: owned.promise,
      release: () => {
        if (released) return
        released = true
        // Current/next panes can share a raster. Cancel only its last consumer.
        if (--owned.users === 0 && this.inflight.get(key) === owned) {
          owned.cancelled = true
          // Let an already-started page finish so the worker is drained before
          // the next job. Its pixels are discarded; queued jobs never start.
          this.inflight.delete(key)
        }
      },
    }
  }

  async renderPageTo(
    pageNum: number,
    visibleCanvas: HTMLCanvasElement,
    targetWidth: number,
    targetHeight = Infinity,
  ): Promise<void> {
    // Acquire first so promoting a prefetch/shared request keeps its render alive.
    const lease = this.acquirePage(pageNum, targetWidth)
    const previous = this.latestRequest.get(visibleCanvas)
    this.latestRequest.set(visibleCanvas, lease)
    previous?.release()
    this.preload?.release()
    this.preload = null
    const tokenAtStart = this.docToken
    try {
      const off = await lease.promise
      if (!off || tokenAtStart !== this.docToken || this.latestRequest.get(visibleCanvas) !== lease) return

      const dpr = devicePixelScale()
      if (visibleCanvas.width !== off.width || visibleCanvas.height !== off.height) {
        visibleCanvas.width = off.width
        visibleCanvas.height = off.height
      }
      // Clamp both dimensions with the same factor. Independent max-height and
      // max-width constraints distort a canvas with an explicit CSS size.
      const width = off.width / dpr, height = off.height / dpr
      const fit = Math.min(1, targetWidth / width, targetHeight > 0 ? targetHeight / height : 1)
      visibleCanvas.style.width = `${width * fit}px`
      visibleCanvas.style.height = `${height * fit}px`

      const ctx = visibleCanvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(off, 0, 0)
    } finally {
      lease.release()
      if (this.latestRequest.get(visibleCanvas) === lease) this.latestRequest.delete(visibleCanvas)
    }
  }

  async prerender(pageNum: number, targetWidth: number): Promise<void> {
    const lease = this.acquirePage(pageNum, targetWidth)
    this.preload?.release()
    this.preload = lease
    try {
      await lease.promise.catch(() => null)
    } finally {
      lease.release()
      if (this.preload === lease) this.preload = null
    }
  }
}

// Default shared instance — backs the free-function API used by audience/speaker
// (single document) and the operator's program pane.
const defaultLoader = new PdfLoader()

export function loadDocument(bytes: Uint8Array | PdfFileSource): Promise<PDFDocumentProxy | null> {
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
  targetHeight = Infinity,
): Promise<void> {
  return defaultLoader.renderPageTo(pageNum, visibleCanvas, targetWidth, targetHeight)
}

export function prerender(pageNum: number, targetWidth: number): Promise<void> {
  return defaultLoader.prerender(pageNum, targetWidth)
}
