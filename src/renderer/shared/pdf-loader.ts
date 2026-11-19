import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

const PAGE_CACHE_MAX = 8
const PAGE_CACHE_BYTES = 24 * 1024 * 1024

interface Raster {
  canvas: HTMLCanvasElement | null
  users: number
  retired: boolean
  task?: RenderTask
  cancelled: boolean
  promise: Promise<Raster | null>
}

function releaseRaster(raster: Raster): void {
  if (raster.retired && raster.users === 0 && raster.canvas) {
    raster.canvas.width = 0
    raster.canvas.height = 0
    raster.canvas = null
  }
}

class OffscreenCache {
  private entries = new Map<string, Raster>()

  contains(raster: Raster): boolean { return [...this.entries.values()].includes(raster) }

  private key(page: number, width: number): string {
    return `${page}@${width}`
  }

  get(page: number, width: number): Raster | undefined {
    const k = this.key(page, width)
    const hit = this.entries.get(k)
    if (hit) {
      this.entries.delete(k)
      this.entries.set(k, hit)
    }
    return hit
  }

  set(page: number, width: number, value: Raster): void {
    const k = this.key(page, width)
    if (this.entries.has(k)) this.entries.delete(k)
    this.entries.set(k, value)
    const bytes = (): number => [...this.entries.values()].reduce((sum, r) => sum + (r.canvas ? r.canvas.width * r.canvas.height * 4 : 0), 0)
    while (this.entries.size > PAGE_CACHE_MAX || bytes() > PAGE_CACHE_BYTES) {
      const firstKey = this.entries.keys().next().value
      if (firstKey === undefined) break
      const old = this.entries.get(firstKey)!
      this.entries.delete(firstKey)
      old.retired = true
      releaseRaster(old)
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) { entry.retired = true; releaseRaster(entry) }
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
  private inflight = new Map<string, Raster>()
  private latestRequest = new WeakMap<HTMLCanvasElement, {key: string; controller: AbortController}>()
  private preload: AbortController | null = null
  private regionTasks = new Set<RenderTask>()
  private doc: PDFDocumentProxy | null = null
  private loadingTask: PDFDocumentLoadingTask | null = null
  private docToken = 0
  private loadRequest = 0

  /** Invalidate immediately; worker teardown can finish asynchronously. */
  async dispose(): Promise<void> {
    ++this.loadRequest
    ++this.docToken
    this.preload?.abort()
    for (const entry of this.inflight.values()) { entry.cancelled = true; entry.task?.cancel() }
    this.inflight.clear()
    for (const task of this.regionTasks) task.cancel()
    this.regionTasks.clear()
    this.cache.clear()
    const doc = this.doc
    this.doc = null
    const loading = this.loadingTask
    this.loadingTask = null
    await Promise.all([doc?.destroy().catch(() => undefined), loading?.destroy().catch(() => undefined)])
  }

  async loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy | null> {
    // Release the old document before awaiting the replacement, including on failure.
    const retired = this.dispose()
    const request = ++this.loadRequest
    const copy = new Uint8Array(bytes)
    const loadingTask = pdfjs.getDocument({ data: copy })
    this.loadingTask = loadingTask
    let newDoc: PDFDocumentProxy
    try {
      newDoc = await loadingTask.promise
    } catch (error) {
      if (request !== this.loadRequest) return null
      throw error
    } finally {
      if (this.loadingTask === loadingTask) this.loadingTask = null
    }
    if (request !== this.loadRequest) {
      await newDoc.destroy().catch(() => undefined)
      return null
    }
    await retired
    if (request !== this.loadRequest) {
      await newDoc.destroy().catch(() => undefined)
      return null
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
    signal: AbortSignal,
  ): Promise<Raster | null> {
    const doc = this.doc
    if (!doc) return null
    if (pageNum < 1 || pageNum > doc.numPages) return null
    if (!Number.isFinite(targetWidth) || targetWidth <= 0 || signal.aborted) return null

    const key = `${pageNum}@${targetWidth}`
    let entry = this.cache.get(pageNum, targetWidth) ?? this.inflight.get(key)
    if (!entry) {
      const tokenAtStart = this.docToken
      const raster: Raster = {canvas: null, users: 0, retired: false, cancelled: false, promise: Promise.resolve(null)}
      entry = raster
      this.inflight.set(key, raster)
      raster.promise = (async () => {
        try {
          const page = await doc.getPage(pageNum)
          if (tokenAtStart !== this.docToken || raster.cancelled) return null

          const baseViewport = page.getViewport({ scale: 1 })
          const dpr = devicePixelScale()
          const scale = (targetWidth / baseViewport.width) * dpr
          const viewport = page.getViewport({ scale })

          const off = document.createElement('canvas')
          off.width = Math.floor(viewport.width)
          off.height = Math.floor(viewport.height)
          raster.canvas = off
          const ctx = off.getContext('2d')
          if (!ctx) return null

          try {
            raster.task = page.render({ canvasContext: ctx, viewport })
            await raster.task.promise
          } catch (err) {
            const name = (err as { name?: string })?.name
            if (name === 'RenderingCancelledException') return null
            throw err
          } finally {
            // The offscreen raster now owns the pixels. Drop page operator/image
            // resources; PDF.js defers cleanup if another render still uses them.
            page.cleanup()
          }
          if (tokenAtStart !== this.docToken || raster.cancelled) return null
          this.cache.set(pageNum, targetWidth, raster)
          return raster
        } catch (error) {
          if (tokenAtStart !== this.docToken || raster.cancelled) return null
          throw error
        } finally {
          if (this.inflight.get(key) === raster) this.inflight.delete(key)
          if (!this.cache.contains(raster)) raster.retired = true
          releaseRaster(raster)
        }
    })()
    }
    const raster = entry
    ++raster.users
    const release = (): void => {
      --raster.users
      if (!raster.users && this.inflight.get(key) === raster) {
        raster.cancelled = true
        raster.task?.cancel()
        this.inflight.delete(key)
      }
      releaseRaster(raster)
    }
    signal.addEventListener('abort', release, {once: true})
    let leased = false
    try {
      const result = await raster.promise
      if (!result || signal.aborted) return null
      leased = true
      return result
    } finally {
      signal.removeEventListener('abort', release)
      // Successful callers own one lease until their synchronous draw completes.
      if (!leased && !signal.aborted) release()
    }
  }

  async renderPageTo(
    pageNum: number,
    visibleCanvas: HTMLCanvasElement,
    targetWidth: number,
    targetHeight = Infinity,
  ): Promise<void> {
    this.preload?.abort()
    const key = `${this.docToken}:${pageNum}@${targetWidth}`
    let request = this.latestRequest.get(visibleCanvas)
    if (request?.key !== key) {
      request?.controller.abort()
      request = {key, controller: new AbortController()}
      this.latestRequest.set(visibleCanvas, request)
    }
    const token = this.docToken
    const {controller} = request
    let raster: Raster | null = null
    try {
      raster = await this.renderToOffscreen(pageNum, targetWidth, controller.signal)
      const off = raster?.canvas
      if (!off || token !== this.docToken || controller.signal.aborted || this.latestRequest.get(visibleCanvas) !== request) return

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
      if (raster) { --raster.users; releaseRaster(raster) }
      if (this.latestRequest.get(visibleCanvas) === request) this.latestRequest.delete(visibleCanvas)
    }
  }

  /** Rasterize only the animation's bounded region, without full-page frame caches. */
  async renderRegion(pageNum: number, rect: {x:number;y:number;w:number;h:number}, targetWidth: number, signal?: AbortSignal): Promise<HTMLCanvasElement | null> {
    const doc=this.doc, token=this.docToken
    if(!doc || signal?.aborted || pageNum<1 || pageNum>doc.numPages) return null
    const page=await doc.getPage(pageNum)
    if(token!==this.docToken || signal?.aborted) return null
    const base=page.getViewport({scale:1}), viewport=page.getViewport({scale:Math.min(targetWidth*devicePixelScale(),1920)/base.width})
    const out=document.createElement('canvas');out.width=Math.ceil(viewport.width*rect.w);out.height=Math.ceil(viewport.height*rect.h)
    const task=page.render({canvasContext:out.getContext('2d')!,viewport,transform:[1,0,0,1,-rect.x*viewport.width,-rect.y*viewport.height]})
    const cancel=():void=>task.cancel()
    this.regionTasks.add(task)
    signal?.addEventListener('abort',cancel,{once:true})
    let retained=false
    try {
      await task.promise
      retained=token===this.docToken && !signal?.aborted
      return retained ? out : null
    } catch(error) {
      if((error as {name?:string}).name==='RenderingCancelledException')return null
      throw error
    } finally {
      this.regionTasks.delete(task)
      signal?.removeEventListener('abort',cancel)
      if(!retained){out.width=0;out.height=0}
      page.cleanup()
    }
  }

  async prerender(pageNum: number, targetWidth: number): Promise<void> {
    this.preload?.abort()
    const controller = new AbortController()
    this.preload = controller
    const raster = await this.renderToOffscreen(pageNum, targetWidth, controller.signal).catch(() => null)
    if (raster) { --raster.users; releaseRaster(raster) }
    if (this.preload === controller) this.preload = null
  }
}

// Default shared instance — backs the free-function API used by audience/speaker
// (single document) and the operator's program pane.
const defaultLoader = new PdfLoader()

export function loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy | null> {
  return defaultLoader.loadDocument(bytes)
}

export function getDocument(): PDFDocumentProxy | null {
  return defaultLoader.getDocument()
}

export function disposeDocument(): Promise<void> { return defaultLoader.dispose() }

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
