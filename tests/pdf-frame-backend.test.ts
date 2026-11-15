import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { PdfFrameBackend } from '../src/render-backends/pdfjs'
import type { SlideFrameKey } from '../packages/render-core/src/frame-source'

const key: SlideFrameKey = { document: 'revision', page: 1, width: 100, height: 100, rotation: 0 }
function setup(size = 100) {
  const context = { fillStyle: '', fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => { const data = new Uint8ClampedArray(width * height * 4); data.fill(41); return { data } }) }
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement
  const cleanup = vi.fn()
  const getViewport = vi.fn(({ scale, rotation }: { scale: number; rotation: number }) => ({ width: 200 * scale, height: 100 * scale, rotation }))
  const task = { promise: Promise.resolve(), cancel: vi.fn() }
  const page = { rotate: 90, getViewport, render: vi.fn(() => task), cleanup } as unknown as PDFPageProxy
  const doc = { numPages: 2, getPage: vi.fn(async () => page), destroy: vi.fn(async () => undefined) } as unknown as PDFDocumentProxy
  const open = vi.fn(async () => doc)
  const backend = new PdfFrameBackend([{ id: 'revision', size, open }], () => canvas)
  return { backend, open, doc, page, task, canvas, cleanup, getViewport, context }
}

it('opens one PDF for different pages and sizes, and preserves intrinsic rotation', async () => {
  const { backend, open, canvas, getViewport, context } = setup()
  const signal = new AbortController().signal
  const first = await backend.render(key, signal)
  expect([...first.pixels.slice(0, 4)]).toEqual([0, 0, 0, 255])
  expect([...first.pixels.slice(25 * 100 * 4, 25 * 100 * 4 + 4)]).toEqual([41, 41, 41, 41])
  first.close()
  expect(first.pixels.byteLength).toBe(0)
  await backend.render({ ...key, page: 2, rotation: 90 }, signal)
  expect(open).toHaveBeenCalledOnce()
  expect(getViewport.mock.calls[0][0].rotation).toBe(90)
  expect(getViewport.mock.calls[2][0].rotation).toBe(180)
  expect(context.clip).not.toHaveBeenCalled()
  expect(context.save).not.toHaveBeenCalled()
  expect(context.fillRect).not.toHaveBeenCalled()
  expect(canvas.width).toBe(0)
  await backend.dispose()
})

it('keeps a large page decoded across output sizes, releases before another page and on idle', async () => {
  vi.useFakeTimers()
  try {
  for (const size of [100, 256 * 1024 * 1024]) {
    const { backend, cleanup, context } = setup(size)
    const frame = await backend.render(key, new AbortController().signal)
    expect(cleanup).not.toHaveBeenCalled()
    await backend.render({ ...key, width: 120 }, new AbortController().signal)
    expect(backend.stats.decodedReused).toBe(size === 100 ? 0 : 1)
    await backend.render({ ...key, page: 2 }, new AbortController().signal)
    expect(cleanup).toHaveBeenCalledTimes(size === 100 ? 0 : 1)
    await vi.advanceTimersByTimeAsync(300)
    expect(cleanup).toHaveBeenCalledTimes(size === 100 ? 0 : 2)
    if (size > 100) expect(context.getImageData.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0])
    frame.close(); await backend.dispose()
  }
  } finally { vi.useRealTimers() }
})

it('drains an obsolete active PDF render before starting another page', async () => {
  const { backend, task, canvas, cleanup } = setup(256 * 1024 * 1024)
  let finish!: () => void
  task.promise = new Promise(resolve => { finish = resolve })
  const controller = new AbortController()
  const result = backend.render(key, controller.signal)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  controller.abort()
  expect(task.cancel).not.toHaveBeenCalled()
  expect(canvas.width).toBe(100)
  finish()
  await expect(result).rejects.toThrow('cancelled')
  expect(canvas.width).toBe(0)
  expect(cleanup).toHaveBeenCalledOnce()
  await backend.dispose()
})

it('does not open an unknown revision or touch a page outside the PDF', async () => {
  const { backend, open, doc } = setup()
  await expect(backend.render({ ...key, document: 'missing' }, new AbortController().signal)).rejects.toThrow('Unknown')
  expect(open).not.toHaveBeenCalled()
  await expect(backend.render({ ...key, page: 3 }, new AbortController().signal)).rejects.toThrow('range')
  expect(doc.getPage).not.toHaveBeenCalled()
  await backend.dispose()
  expect(doc.destroy).toHaveBeenCalledOnce()
  await expect(backend.render(key, new AbortController().signal)).rejects.toThrow('cancelled')
})

it('can retry a failed opening without keeping a rejected document', async () => {
  const { backend, open } = setup()
  open.mockRejectedValueOnce(new Error('bad PDF'))
  await expect(backend.render(key, new AbortController().signal)).rejects.toThrow('bad PDF')
  const frame = await backend.render(key, new AbortController().signal)
  expect(open).toHaveBeenCalledTimes(2)
  frame.close(); await backend.dispose()
})

it('rejects duplicate identities and an unbounded document set', () => {
  const source = { id: 'a', size: 1, open: vi.fn() }
  expect(() => new PdfFrameBackend([source, source])).toThrow('two distinct')
  expect(() => new PdfFrameBackend([source, { ...source, id: 'b' }, { ...source, id: 'c' }])).toThrow('two distinct')
})
