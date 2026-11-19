import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SlideBuildAnimation } from '../src/shared/types'

const mock = vi.hoisted(() => ({ load: vi.fn(), region: vi.fn(), dispose: vi.fn(), baseWidth: 1000, baseHeight: 500 }))
vi.mock('../src/renderer/shared/animation-frame-loader', () => ({ PdfLoader: class {
  loadDocument = mock.load
  renderRegion = mock.region
  dispose = mock.dispose
  totalPages = () => 16
  getDocument = () => ({getPage: async () => ({getViewport: () => ({width: mock.baseWidth, height: mock.baseHeight})})})
} }))
import { TakeFade } from '../src/renderer/shared/take-fade'

let displayWidth = 1000
class Canvas {
  width = 1000; height = 500
  getBoundingClientRect = () => ({width: displayWidth})
}
const build: SlideBuildAnimation = {kind: 'native-frames', framesFile: 'frames.pdf', frameCount: 16, durationMs: 500, rect: {x: 0, y: 0, w: 1, h: 1}}
beforeEach(() => {
  displayWidth = 1000
  vi.clearAllMocks()
  mock.load.mockResolvedValue({}); mock.dispose.mockResolvedValue(undefined)
  mock.region.mockImplementation(async (_page, rect, width) => ({width: Math.ceil(width*rect.w), height: Math.ceil(width*0.5*rect.h)}))
  vi.stubGlobal('window', {devicePixelRatio: 1, api: {pptx: {readAnimationFrames: async () => new Uint8Array([1])}}})
  vi.stubGlobal('HTMLCanvasElement', Canvas)
  vi.stubGlobal('getComputedStyle', () => ({display: 'block'}))
})
afterEach(() => vi.unstubAllGlobals())
const fade = () => new TakeFade({} as HTMLElement, [new Canvas() as unknown as HTMLCanvasElement])
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve() }

it('bounds full-frame sequences by bytes without changing crop or frame count', async () => {
  displayWidth = 2000
  const f = fade(), frames = await f.prepareNative(build, 'sha')!
  expect(frames).toHaveLength(16)
  expect(frames.reduce((n,c) => n+c.width*c.height*4,0)).toBeLessThanOrEqual(32*1024*1024)
  expect(mock.region.mock.calls.every(c => c[1] === build.rect)).toBe(true)
  expect(mock.region.mock.calls.every(c => c[2] < 2000)).toBe(true)
  const saved = [...frames]
  f.prepareNative(undefined, 'sha')
  expect(saved.every(c => c.width === 0 && c.height === 0)).toBe(true)
})

it('releases a late region result after replacement instead of reviving the retired cache', async () => {
  let finish!: (canvas: Canvas) => void
  mock.region.mockImplementationOnce(() => new Promise(resolve => {finish=resolve}))
  const f = fade(), pending = f.prepareNative(build, 'sha')!
  await flush()
  f.clearNative()
  const late = new Canvas(); finish(late)
  expect(await pending).toEqual([])
  expect(late.width).toBe(0); expect(late.height).toBe(0)
  expect(mock.region).toHaveBeenCalledOnce()
})

it('never starts a PDF worker for an IPC read that has become obsolete', async () => {
  let read!: (bytes: Uint8Array) => void
  window.api.pptx.readAnimationFrames = vi.fn(() => new Promise<Uint8Array>(resolve => {read=resolve}))
  const f = fade(), pending = f.prepareNative(build, 'sha')!
  f.clearNative(); read(new Uint8Array([1])); await pending
  expect(mock.load).not.toHaveBeenCalled()
  expect(mock.region).not.toHaveBeenCalled()
})

it('preserves the existing raster size for measured crops that fit the budget', async () => {
  const f = fade(), crop = {...build, rect: {x: 0.2, y: 0, w: 0.21, h: 0.86}}
  const frames = await f.prepareNative(crop, 'sha')!
  expect(mock.region.mock.calls.every(c => c[2] === 1000)).toBe(true)
  expect(frames).toHaveLength(16)
})
