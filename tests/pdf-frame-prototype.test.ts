import { afterEach, expect, it, vi } from 'vitest'
import * as pdfjs from 'pdfjs-dist'
import { createPdfFramePrototype } from '../src/renderer/shared/pdf-frame-prototype'

const state = vi.hoisted(() => ({ ranges: [] as { abort: ReturnType<typeof vi.fn>; fail(error: Error): void }[] }))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }))
vi.mock('../src/renderer/shared/pdf-range-transport', () => ({
  LocalPdfRangeTransport: class {
    abort = vi.fn()
    failure: Promise<never>
    constructor() {
      let fail!: (error: Error) => void
      this.failure = new Promise((_, reject) => { fail = reject })
      state.ranges.push({ abort: this.abort, fail })
    }
  },
}))
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
const sources = [{ id: 'a', file: { url: 'cuedeck-media://pdf/a', size: 100 } }]
const key = { document: 'a', page: 1, width: 100, height: 100, rotation: 0 as const }
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); state.ranges.length = 0 })
function opening() {
  vi.stubGlobal('navigator', { userAgent: 'test' })
  let reject!: (error: Error) => void
  const promise = new Promise((_, no) => { reject = no })
  const task = { promise, destroy: vi.fn(async () => { reject(new Error('destroyed')) }) }
  vi.mocked(pdfjs.getDocument).mockReturnValue(task as unknown as ReturnType<typeof pdfjs.getDocument>)
  return task
}

it('destroys an opening task on stop without waiting for its header forever', async () => {
  const task = opening()
  const owner = createPdfFramePrototype(sources)
  const request = owner.frames.request('pgm', key, 'program')
  await tick()
  expect(pdfjs.getDocument).toHaveBeenCalledOnce()
  await owner.stop()
  expect(await request).toBeNull()
  expect(task.destroy).toHaveBeenCalled()
})

it('does not start a deferred opening after immediate stop', async () => {
  opening()
  const owner = createPdfFramePrototype(sources)
  const request = owner.frames.request('pgm', key, 'program')
  await Promise.resolve() // pump ran, source.open is still a microtask
  await owner.stop()
  expect(await request).toBeNull()
  expect(pdfjs.getDocument).not.toHaveBeenCalled()
})

it('rejects a failed range and destroys the pending PDF worker', async () => {
  const task = opening()
  const owner = createPdfFramePrototype(sources)
  const request = owner.frames.request('pgm', key, 'program')
  const rejected = expect(request).rejects.toThrow('bad range')
  await tick()
  state.ranges[0].fail(new Error('bad range'))
  await rejected
  expect(task.destroy).toHaveBeenCalled()
  expect(state.ranges[0].abort).toHaveBeenCalledOnce()
  await owner.stop()
})

it('keeps the loaded task available for shutdown while a page is being decoded', async () => {
  vi.stubGlobal('navigator', { userAgent: 'test' })
  let rejectPage!: (error: Error) => void
  const page = new Promise((_, reject) => { rejectPage = reject })
  const doc = { numPages: 1, getPage: vi.fn(() => page), destroy: vi.fn(async () => {}) }
  const task = { promise: Promise.resolve(doc), destroy: vi.fn(async () => { rejectPage(new Error('worker stopped')) }) }
  vi.mocked(pdfjs.getDocument).mockReturnValue(task as unknown as ReturnType<typeof pdfjs.getDocument>)
  const owner = createPdfFramePrototype(sources)
  await owner.frames.describe('a')
  const request = owner.frames.request('pgm', key, 'program')
  await tick()
  expect(doc.getPage).toHaveBeenCalledOnce()
  await owner.stop()
  expect(await request).toBeNull()
  expect(task.destroy).toHaveBeenCalled()
  expect(doc.destroy).toHaveBeenCalledOnce()
})

it('destroys a loaded worker when a later range fails', async () => {
  vi.stubGlobal('navigator', { userAgent: 'test' })
  const doc = { numPages: 1, destroy: vi.fn(async () => {}) }
  const task = { promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) }
  vi.mocked(pdfjs.getDocument).mockReturnValue(task as unknown as ReturnType<typeof pdfjs.getDocument>)
  const owner = createPdfFramePrototype(sources)
  await owner.frames.describe('a')
  state.ranges[0].fail(new Error('late range failure'))
  await tick()
  expect(task.destroy).toHaveBeenCalledOnce()
  await owner.stop()
})

it('Preview replacement retires only its worker, retaining the Program document', async () => {
  vi.stubGlobal('navigator', { userAgent: 'test' })
  const docs = Array.from({ length: 3 }, () => ({ numPages: 3, destroy: vi.fn(async () => {}) }))
  const tasks = docs.map(doc => ({ promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) }))
  for (const task of tasks) vi.mocked(pdfjs.getDocument).mockReturnValueOnce(task as unknown as ReturnType<typeof pdfjs.getDocument>)
  const source = (id: string) => ({ id, file: { url: `cuedeck-media://pdf-source/${id}`, size: 100 } })
  const owner = createPdfFramePrototype([])
  await owner.sync([source('pgm'), source('preview')])
  await owner.sync([source('pgm'), source('next-preview')])
  expect(owner.backend.stats.opened).toBe(3)
  expect(tasks[0].destroy).not.toHaveBeenCalled()
  expect(tasks[1].destroy).toHaveBeenCalledOnce()
  expect(docs[0].destroy).not.toHaveBeenCalled()
  expect(docs[1].destroy).toHaveBeenCalledOnce()
  expect(await owner.frames.describe('pgm')).toEqual({ id: 'pgm', pages: 3 })
  await owner.stop()
})
