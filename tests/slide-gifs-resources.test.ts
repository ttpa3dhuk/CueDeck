import { afterEach, expect, it, vi } from 'vitest'
import { SlideGifs } from '../src/renderer/shared/slide-gifs'
vi.mock('../src/renderer/shared/video', () => ({slideVideoSrc: () => 'cuedeck-media://gif', placeSlideOverlay: vi.fn()}))
afterEach(() => vi.unstubAllGlobals())
it('detaches hidden GIF sources and callbacks, and recreates them when visible again', () => {
  const images: {src?: string; onerror: unknown; removeAttribute: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>}[] = []
  vi.stubGlobal('document', {createElement: () => {
    const image = {style: {}, dataset: {}, onerror: null, removeAttribute: vi.fn(), remove: vi.fn()}
    images.push(image); return image
  }})
  vi.stubGlobal('window', {api: {diag: {log: vi.fn()}}})
  let hidden = false
  const canvas = {classList: {contains: () => hidden}, parentElement: {append: vi.fn()}} as unknown as HTMLCanvasElement
  const gifs = new SlideGifs(canvas, 'program')
  const media = [{kind: 'gif' as const, slide: 1, file: 'test.gif', rect: {x: 0, y: 0, w: 1, h: 1}}]
  gifs.update('pptx', media, 1, 'sha', true)
  expect(gifs.elements()).toHaveLength(1)
  hidden = true; gifs.update('pptx', media, 1, 'sha', true)
  expect(gifs.elements()).toHaveLength(0)
  expect(images[0].removeAttribute).toHaveBeenCalledWith('src')
  expect(images[0].onerror).toBeNull()
  hidden = false; gifs.update('pptx', media, 1, 'sha', true)
  expect(gifs.elements()).toHaveLength(1)
  expect(images).toHaveLength(2)
  expect(images[1].src).not.toBe(images[0].src)
})
