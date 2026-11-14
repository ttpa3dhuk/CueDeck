import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdf = vi.hoisted(() => ({ documents: [] as unknown[] }))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {}, PDFDataRangeTransport: class {},
  getDocument: () => ({ promise: Promise.resolve(pdf.documents.shift()) }),
}))
import { PdfLoader } from '../src/renderer/shared/pdf-loader'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve() }
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })

function canvas() {
  const drawImage = vi.fn()
  return { width: 0, height: 0, style: {}, getContext: () => ({ drawImage }), drawImage } as unknown as HTMLCanvasElement & { drawImage: ReturnType<typeof vi.fn> }
}
function documentFixture() {
  const tasks: { page: number; raster: HTMLCanvasElement; done: ReturnType<typeof deferred<void>>; cancel: ReturnType<typeof vi.fn> }[] = []
  const makePage = (n: number) => ({
    cleanup: vi.fn(() => true),
    getViewport: ({ scale }: { scale: number }) => ({ width: 1600 * scale, height: 900 * scale }),
    render: ({ canvasContext }: { canvasContext: { canvas: HTMLCanvasElement } }) => {
      const done = deferred<void>()
      const cancel = vi.fn(() => done.reject(cancelled()))
      tasks.push({ page: n, raster: canvasContext.canvas, done, cancel })
      return { promise: done.promise, cancel }
    },
  })
  const pages = new Map<number, ReturnType<typeof makePage>>()
  const doc = { numPages: 93, getPage: vi.fn(async (n: number) => {
    let page = pages.get(n)
    if (!page) { page = makePage(n); pages.set(n, page) }
    return page
  }), destroy: vi.fn(async () => {}) }
  pdf.documents.push(doc)
  return { doc, tasks, makePage, pages }
}

beforeEach(() => {
  pdf.documents.length = 0
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('document', { createElement: () => {
    const off = { width: 0, height: 0, getContext: () => ({ canvas: off }) }
    return off
  } })
})
afterEach(() => vi.unstubAllGlobals())

describe('PDF request ownership', () => {
  it('releases decoded page resources only after rendering and keeps the completed raster usable', async () => {
    const { tasks, pages } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument({ url: 'cuedeck-media://document/program?v=large', size: 1024 ** 3 })
    const paint = loader.renderPageTo(1, visible, 1920)
    await flush()
    expect(pages.get(1)!.cleanup).not.toHaveBeenCalled()
    tasks[0].done.resolve()
    await paint
    expect(pages.get(1)!.cleanup).toHaveBeenCalledOnce()
    expect(visible.drawImage).toHaveBeenCalledExactlyOnceWith(tasks[0].raster, 0, 0)
    await loader.renderPageTo(1, visible, 1920)
    expect(tasks).toHaveLength(1)
    expect(visible.drawImage).toHaveBeenCalledTimes(2)
  })

  it('releases decoded resources when a render fails before moving to the next page', async () => {
    const { tasks, pages } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument({ url: 'cuedeck-media://document/program?v=large', size: 1024 ** 3 })
    const paint = loader.renderPageTo(1, visible, 1920)
    const failed = expect(paint).rejects.toThrow('decode failed')
    await flush(); tasks[0].done.reject(new Error('decode failed')); await failed
    expect(pages.get(1)!.cleanup).toHaveBeenCalledOnce()
    const next = loader.renderPageTo(2, visible, 1920)
    await flush(); tasks[1].done.resolve(); await next
    expect(visible.drawImage).toHaveBeenCalledExactlyOnceWith(tasks[1].raster, 0, 0)
  })
  it.each([[256 * 1024 * 1024 - 1, false], [256 * 1024 * 1024, true]] as const)(
    'keeps decoded reuse below the large-document boundary (%s bytes)', async (size, eager) => {
      const { tasks, pages } = documentFixture(), loader = new PdfLoader(), visible = canvas()
      await loader.loadDocument({ url: 'cuedeck-media://document/program?v=boundary', size })
      const paint = loader.renderPageTo(1, visible, 1920)
      await flush(); tasks[0].done.resolve(); await paint
      expect(pages.get(1)!.cleanup).toHaveBeenCalledTimes(eager ? 1 : 0)
    },
  )
  it('restores normal decoded-page reuse after replacing a large document', async () => {
    const large = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument({ url: 'cuedeck-media://document/program?v=large', size: 1024 ** 3 })
    const first = loader.renderPageTo(1, visible, 1920)
    await flush(); large.tasks[0].done.resolve(); await first
    expect(large.pages.get(1)!.cleanup).toHaveBeenCalledOnce()
    const small = documentFixture()
    await loader.loadDocument(new Uint8Array())
    const next = loader.renderPageTo(1, visible, 1920)
    await flush(); small.tasks[0].done.resolve(); await next
    expect(small.pages.get(1)!.cleanup).not.toHaveBeenCalled()
  })
  it('drains one active render, skips obsolete work and draws only the latest page', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const first = loader.renderPageTo(1, visible, 1920)
    await flush()
    const last = loader.renderPageTo(89, visible, 1920)
    await flush()
    expect(tasks[0].cancel).not.toHaveBeenCalled()
    expect(tasks).toHaveLength(1)
    tasks[0].done.resolve()
    await flush()
    expect(tasks[0].raster.width).toBe(0)
    tasks[1].done.resolve()
    await Promise.all([first, last])
    expect(visible.drawImage).toHaveBeenCalledExactlyOnceWith(tasks[1].raster, 0, 0)
  })

  it('does not start rasterization after a superseded getPage resolves', async () => {
    const { doc, makePage, tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    const pending = deferred<ReturnType<typeof makePage>>()
    doc.getPage.mockImplementationOnce(() => pending.promise)
    await loader.loadDocument(new Uint8Array())
    const first = loader.renderPageTo(1, visible, 1920)
    await flush()
    const last = loader.renderPageTo(2, visible, 1920)
    await flush()
    pending.resolve(makePage(1))
    await flush()
    tasks[0].done.resolve()
    await Promise.all([first, last])
    expect(tasks.map(t => t.page)).toEqual([2])
  })

  it('keeps a shared render alive while another canvas still needs it', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), current = canvas(), next = canvas()
    await loader.loadDocument(new Uint8Array())
    const a = loader.renderPageTo(2, current, 1920)
    const b = loader.renderPageTo(2, next, 1920)
    await flush()
    const c = loader.renderPageTo(3, current, 1920)
    await flush()
    expect(tasks[0].cancel).not.toHaveBeenCalled()
    tasks[0].done.resolve()
    await flush()
    tasks[1].done.resolve()
    await Promise.all([a, b, c])
    expect(tasks.map(t => t.page)).toEqual([2, 3])
    expect(next.drawImage).toHaveBeenCalledExactlyOnceWith(tasks[0].raster, 0, 0)
    expect(current.drawImage).toHaveBeenCalledExactlyOnceWith(tasks[1].raster, 0, 0)
  })

  it('promotes a prefetch without cancelling or duplicating it', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const preload = loader.prerender(2, 1920)
    await flush()
    const paint = loader.renderPageTo(2, visible, 1920)
    await flush()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].cancel).not.toHaveBeenCalled()
    tasks[0].done.resolve()
    await Promise.all([preload, paint])
    expect(visible.drawImage).toHaveBeenCalledOnce()
  })

  it('replaces obsolete prefetches and prioritizes the visible page', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const a = loader.prerender(1, 1920)
    await flush()
    const b = loader.prerender(2, 1920)
    await flush()
    const c = loader.renderPageTo(89, visible, 1920)
    await flush()
    expect(tasks).toHaveLength(1)
    tasks[0].done.resolve()
    await flush()
    expect(tasks.map(t => t.page)).toEqual([1, 89])
    tasks[1].done.resolve()
    await Promise.all([a, b, c])
    expect(visible.drawImage).toHaveBeenCalledExactlyOnceWith(tasks[1].raster, 0, 0)
  })

  it('allows A → B → A while an old cancelled A is still settling', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas(), other = canvas()
    await loader.loadDocument(new Uint8Array())
    const a = loader.renderPageTo(1, visible, 1920)
    await flush()
    tasks[0].cancel.mockImplementation(() => {})
    const b = loader.renderPageTo(2, visible, 1920)
    const c = loader.renderPageTo(1, visible, 1920)
    await flush()
    tasks[0].done.reject(cancelled())
    await flush()
    const d = loader.renderPageTo(1, other, 1920)
    await flush()
    expect(tasks.map(t => t.page)).toEqual([1, 1])
    tasks[1].done.resolve()
    await Promise.all([a, b, c, d])
    expect(visible.drawImage).toHaveBeenCalledOnce()
    expect(other.drawImage).toHaveBeenCalledOnce()
  })

  it('does not paint an obsolete width for the same page', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const a = loader.renderPageTo(1, visible, 400)
    await flush()
    const b = loader.renderPageTo(1, visible, 800)
    await flush()
    expect(tasks).toHaveLength(1)
    tasks[0].done.resolve()
    await flush(); tasks[1].done.resolve()
    await Promise.all([a, b])
    expect(visible.width).toBe(800)
    expect(visible.drawImage).toHaveBeenCalledOnce()
  })

  it('uses the completed cache and separates device pixel scales', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const a = loader.renderPageTo(1, visible, 400)
    await flush(); tasks[0].done.resolve(); await a
    await loader.renderPageTo(1, visible, 400)
    expect(tasks).toHaveLength(1)
    window.devicePixelRatio = 2
    const b = loader.renderPageTo(1, visible, 400)
    await flush(); tasks[1].done.resolve(); await b
    expect(visible.width).toBe(800)
  })

  it('invalidates old pages immediately when replacing a document', async () => {
    const { tasks, doc } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const a = loader.renderPageTo(1, visible, 400)
    await flush()
    const replacement = documentFixture()
    const loading = loader.loadDocument(new Uint8Array())
    expect(tasks[0].cancel).toHaveBeenCalledOnce()
    await loading; await a
    expect(doc.destroy).toHaveBeenCalledOnce()
    expect(visible.drawImage).not.toHaveBeenCalled()
    const b = loader.renderPageTo(1, visible, 400)
    await flush(); replacement.tasks[0].done.resolve(); await b
    expect(visible.drawImage).toHaveBeenCalledExactlyOnceWith(replacement.tasks[0].raster, 0, 0)
  })

  it('feeds only the active and last requested pages to PDF.js during a burst', async () => {
    const { tasks, doc } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const pending = [loader.renderPageTo(1, visible, 1920)]
    await flush()
    for (let page = 2; page <= 89; page++) pending.push(loader.renderPageTo(page, visible, 1920))
    expect(doc.getPage).toHaveBeenCalledTimes(1)
    tasks[0].done.resolve()
    for (let i = 0; i < 100; i++) await flush()
    expect(tasks.map(t => t.page)).toEqual([1, 89])
    tasks[1].done.resolve()
    await Promise.all(pending)
    expect(visible.drawImage).toHaveBeenCalledExactlyOnceWith(tasks[1].raster, 0, 0)
  })

  it('propagates real errors and permits a clean retry', async () => {
    const { tasks } = documentFixture(), loader = new PdfLoader(), visible = canvas()
    await loader.loadDocument(new Uint8Array())
    const a = loader.renderPageTo(1, visible, 400)
    const failed = expect(a).rejects.toThrow('broken PDF')
    await flush(); tasks[0].done.reject(new Error('broken PDF')); await failed
    expect(tasks[0].raster.width).toBe(0)
    const b = loader.renderPageTo(1, visible, 400)
    await flush(); tasks[1].done.resolve(); await b
    expect(visible.drawImage).toHaveBeenCalledOnce()
  })
})
