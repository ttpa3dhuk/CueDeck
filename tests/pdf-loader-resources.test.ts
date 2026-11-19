import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: mock.getDocument }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker' }))
import { PdfLoader } from '../src/renderer/shared/pdf-loader'

class Canvas {
  width = 0; height = 0; style = {width: '', height: ''}
  draws: number[] = []
  page = 0
  getContext() { return { drawImage: (source: Canvas) => { expect(source.width).toBeGreaterThan(0); this.draws.push(source.page) } } }
}
const allocated: Canvas[] = []
const tasks: {page: number; finish: () => void; cancel: ReturnType<typeof vi.fn>}[] = []
let auto = true
let destroy: ReturnType<typeof vi.fn>
beforeEach(() => {
  auto = true; allocated.length = 0; tasks.length = 0
  vi.stubGlobal('window', {devicePixelRatio: 1})
  vi.stubGlobal('document', {createElement: () => { const c = new Canvas(); allocated.push(c); return c }})
  destroy = vi.fn(async () => {})
  mock.getDocument.mockReturnValue({promise: Promise.resolve({numPages: 50, destroy,
    getPage: async (page: number) => ({
      cleanup: vi.fn(),
      getViewport: ({scale}: {scale: number}) => ({width: 1000 * scale, height: 500 * scale}),
      render: ({canvasContext}: {canvasContext: unknown}) => {
        // Canvas context identity is irrelevant to the cancellation test.
        void canvasContext
        const canvas = allocated.at(-1)!
        canvas.page = page
        let finish!: () => void, fail!: (e: Error) => void
        const promise = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
        const cancel = vi.fn(() => fail(Object.assign(new Error('cancelled'), {name: 'RenderingCancelledException'})))
        tasks.push({page, finish, cancel})
        if (auto) finish()
        return {promise, cancel}
      },
    }),
  })})
})
afterEach(() => vi.unstubAllGlobals())
const canvas = () => new Canvas() as unknown as HTMLCanvasElement
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
async function loader() { const l = new PdfLoader(); await l.loadDocument(new Uint8Array([1])); return l }

it('evicts by bytes and releases backing stores, while an oversized raster still draws before release', async () => {
  const l = await loader(), visible = canvas()
  for (let i = 1; i <= 5; i++) await l.renderPageTo(i, visible, 2000)
  expect(allocated.slice(0, 2).every(c => c.width === 0 && c.height === 0)).toBe(true)
  expect(allocated.reduce((sum, c) => sum + c.width*c.height*4, 0)).toBeLessThanOrEqual(24*1024*1024)
  await l.renderPageTo(6, visible, 5000)
  expect((visible as unknown as Canvas).draws.at(-1)).toBe(6)
  expect(allocated.at(-1)!.width).toBe(0)
  await l.dispose()
  expect(allocated.every(c => c.width === 0 && c.height === 0)).toBe(true)
  expect(destroy).toHaveBeenCalledOnce()
})

it('cancels superseded renders for one surface and never paints a stale result', async () => {
  auto = false
  const l = await loader(), visible = canvas()
  const first = l.renderPageTo(1, visible, 1000); await flush()
  const second = l.renderPageTo(2, visible, 1000); await flush()
  expect(tasks[0].cancel).toHaveBeenCalledOnce()
  tasks[1].finish(); await Promise.all([first, second])
  expect((visible as unknown as Canvas).draws).toEqual([2])
  expect(allocated[0].width).toBe(0)
})

it('keeps a shared render alive for another surface when its first consumer is cancelled', async () => {
  auto = false
  const l = await loader(), a = canvas(), b = canvas()
  const first = l.renderPageTo(1, a, 1000), shared = l.renderPageTo(1, b, 1000); await flush()
  const newer = l.renderPageTo(2, a, 1000); await flush()
  expect(tasks[0].cancel).not.toHaveBeenCalled()
  tasks[0].finish(); tasks[1].finish(); await Promise.all([first, shared, newer])
  expect((a as unknown as Canvas).draws).toEqual([2])
  expect((b as unknown as Canvas).draws).toEqual([1])
})

it('deduplicates repeated requests for the same surface while rendering, instead of starving the picture', async () => {
  auto = false
  const l = await loader(), visible = canvas()
  const a = l.renderPageTo(1, visible, 1000); await flush()
  const b = l.renderPageTo(1, visible, 1000); await flush()
  expect(tasks).toHaveLength(1)
  expect(tasks[0].cancel).not.toHaveBeenCalled()
  tasks[0].finish(); await Promise.all([a,b])
  expect((visible as unknown as Canvas).draws).toEqual([1])
})

it('cancels obsolete preload and does not let an old completion remove a replacement render', async () => {
  auto = false
  const l = await loader()
  const first = l.prerender(1, 1000); await flush()
  const second = l.prerender(2, 1000)
  const third = l.renderPageTo(1, canvas(), 1000); await flush()
  expect(tasks[0].cancel).toHaveBeenCalledOnce()
  // The unused page-2 preload may be cancelled before page.render starts.
  const live = tasks.filter(t => !t.cancel.mock.calls.length)
  for (const task of live) task.finish()
  await Promise.all([first, second, third])
  expect(allocated.filter(c => c.width > 0).map(c => c.page)).toEqual([1])
})

it('releases in-flight region canvases on abort, and invalidates old document work on dispose', async () => {
  auto = false
  const l = await loader(), abort = new AbortController()
  const region = l.renderRegion(1, {x: 0, y: 0, w: 0.5, h: 1}, 1000, abort.signal); await flush()
  abort.abort(); expect(await region).toBeNull()
  expect(allocated[0].width).toBe(0)
  const visible = canvas(), pending = l.renderPageTo(2, visible, 1000); await flush()
  await l.dispose(); await pending
  expect((visible as unknown as Canvas).draws).toEqual([])
  expect(allocated.every(c => c.width === 0)).toBe(true)
})

it('destroys a pending loading task immediately and treats its rejection as an obsolete load', async () => {
  let fail!: (error: Error) => void
  const promise = new Promise((_, reject) => {fail=reject})
  const stop = vi.fn(async () => {fail(new Error('loading aborted'))})
  mock.getDocument.mockReturnValueOnce({promise, destroy: stop})
  const l = new PdfLoader(), loading = l.loadDocument(new Uint8Array([1]))
  await l.dispose()
  expect(stop).toHaveBeenCalledOnce()
  expect(await loading).toBeNull()
  expect(l.getDocument()).toBeNull()
})
