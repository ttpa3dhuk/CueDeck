import { afterEach, expect, it, vi } from 'vitest'
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
  numPages: 2, getPage: async (page: number) => ({ getViewport: ({ scale }: { scale: number }) => ({ width: (page === 2 ? 1200 : 1600) * scale, height: 900 * scale }),
    render: () => ({ promise: Promise.resolve() }) }), destroy: async () => {},
}) }) }))
import { PdfLoader } from '../src/renderer/shared/pdf-loader'
import { paddingBox } from '../src/renderer/shared/element-box'
afterEach(() => vi.unstubAllGlobals())
it('fits the bitmap into a short pane without independently stretching its dimensions', async () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) })
  const drawImage = vi.fn()
  const canvas = { width: 0, height: 0, style: { width: '', height: '' }, getContext: () => ({ drawImage }) }
  const loader = new PdfLoader()
  await loader.loadDocument(new Uint8Array())
  await loader.renderPageTo(1, canvas as unknown as HTMLCanvasElement, 400, 100)
  expect(Number.parseFloat(canvas.style.height)).toBe(100)
  expect(Number.parseFloat(canvas.style.width) / Number.parseFloat(canvas.style.height)).toBeCloseTo(16 / 9)
  expect(drawImage).toHaveBeenCalledOnce()
  await loader.renderPageTo(2, canvas as unknown as HTMLCanvasElement, 400, 100)
  expect(Number.parseFloat(canvas.style.width) / Number.parseFloat(canvas.style.height)).toBeCloseTo(4 / 3)
})
it('uses the same fractional padding box for the live picture and transition snapshot', () => {
  vi.stubGlobal('getComputedStyle', () => ({ borderRightWidth: '3px', borderBottomWidth: '3px' }))
  const host = { clientLeft: 3, clientTop: 3, getBoundingClientRect: () => ({ left: 587, top: 61, width: 401, height: 118.5 }) }
  expect(paddingBox(host as unknown as HTMLElement)).toEqual({ left: 590, top: 64, width: 395, height: 112.5 })
})
