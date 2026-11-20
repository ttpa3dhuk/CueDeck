import { afterEach, expect, it, vi } from 'vitest'
import {
  animationFrame,
  animationStats,
  clearAnimations,
  composeFrame,
} from '../src/renderer/pdf-owner/animation-frames'

const mock = vi.hoisted(() => ({ region: vi.fn(), dispose: vi.fn() }))
vi.mock('../src/renderer/shared/animation-frame-loader', () => ({
  PdfLoader: class {
    loadDocument = async () => true
    totalPages = () => 1
    getDocument = () => ({ getPage: async () => ({ getViewport: () => ({ width: 16, height: 9 }) }) })
    dispose = mock.dispose
    renderRegion = mock.region
  },
}))
afterEach(() => {
  clearAnimations()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('renders one raster and one composition for three consumers, then reacquires after owner reset', async () => {
  const canvas = () => ({
    width: 16,
    height: 9,
    toBlob: (cb: (b: Blob) => void) => cb(new Blob(['pixels'])),
    getContext: () => ({ setTransform: vi.fn(), drawImage: vi.fn() }),
  })
  mock.region.mockImplementation(async () => canvas())
  vi.stubGlobal('window', { devicePixelRatio: 1, pdfOwner: { animationBytes: async () => new Uint8Array([1]) } })
  vi.stubGlobal('document', { createElement: canvas })
  vi.stubGlobal('createImageBitmap', async () => ({ width: 16, height: 9, close: vi.fn() }))
  const asset = { sha: 'deck', file: 'layers.pdf' }
  const region = { page: 1, width: 16, alpha: false, rect: { x: 0, y: 0, w: 1, h: 1 } }
  const scene = {
    width: 16,
    height: 9,
    sprites: [{ region, transform: [1, 0, 0, 1, 0, 0], destination: [0, 0, 16, 9], opacity: 1 }],
  }
  await Promise.all(Array.from({ length: 3 }, () => animationFrame(asset, region)))
  const before = animationStats.composed
  const results = await Promise.all(Array.from({ length: 3 }, () => composeFrame(asset, scene)))
  expect(mock.region).toHaveBeenCalledTimes(1)
  expect(animationStats.composed - before).toBe(1)
  expect(results[0]).toBe(results[2])
  clearAnimations()
  expect(await composeFrame(asset, scene)).toEqual(results[0])
  expect(mock.region).toHaveBeenCalledTimes(2)
})

it('retires animation documents when a rebuilt deck has the same SHA but a new root', async () => {
  const animationBytes = vi.fn(async () => new Uint8Array([1]))
  vi.stubGlobal('window', { pdfOwner: { animationBytes } })
  const asset = { sha: 'same-source', file: 'layers.pdf' }
  clearAnimations(asset.sha, '/cache/v-1/deck.pdf')
  await animationFrame(asset)
  clearAnimations(asset.sha, '/cache/v-1/deck.pdf')
  await animationFrame(asset)
  expect(animationBytes).toHaveBeenCalledTimes(1)

  const disposed = mock.dispose.mock.calls.length
  clearAnimations(asset.sha, '/cache/v-2/deck.pdf')
  await animationFrame(asset)
  expect(animationBytes).toHaveBeenCalledTimes(2)
  expect(mock.dispose.mock.calls.length).toBe(disposed + 1)
})
