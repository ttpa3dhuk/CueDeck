import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { crossfadeToImage } from '../src/renderer/shared/video'

function image(src: string) {
  const classes = new Set<string>()
  return { src, getAttribute(this: { src: string }, name: string) { return name === 'src' ? this.src : null },
    removeAttribute(this: { src: string }) { this.src = '' }, style: { transition: '', opacity: '1' },
    classList: { contains: (name: string) => classes.has(name), add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    decode: vi.fn(async () => {}), offsetWidth: 100 } as unknown as HTMLImageElement
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('keeps the newer backdrop until its own fade finishes', async () => {
  const img = image('a'), under = image('')
  const a = crossfadeToImage(img, under, 'b', 100)
  await vi.advanceTimersByTimeAsync(60)
  const b = crossfadeToImage(img, under, 'c', 300)
  await vi.advanceTimersByTimeAsync(100)
  expect(under.classList.contains('hidden')).toBe(false)
  expect(under.src).toBe('b'); expect(img.src).toBe('c')
  await vi.runAllTimersAsync(); await Promise.all([a, b])
  expect(under.classList.contains('hidden')).toBe(true)
  expect(under.src).toBe('')
})
it('ignores a stale decode that finishes after the next image starts fading', async () => {
  const img = image('a'), under = image(''); let decode!: () => void
  vi.mocked(img.decode).mockImplementationOnce(() => new Promise<void>(resolve => { decode = resolve }))
  const a = crossfadeToImage(img, under, 'b', 100)
  const b = crossfadeToImage(img, under, 'c', 300)
  await vi.advanceTimersByTimeAsync(10); decode(); await a
  expect(img.style.transition).toBe('opacity 300ms linear')
  expect(img.src).toBe('c'); expect(under.classList.contains('hidden')).toBe(false)
  await vi.runAllTimersAsync(); await b
})
it('a cut cancels a pending decode and clears the old backdrop immediately', async () => {
  const img = image('a'), under = image(''); let decode!: () => void
  vi.mocked(img.decode).mockImplementationOnce(() => new Promise<void>(resolve => { decode = resolve }))
  const a = crossfadeToImage(img, under, 'b', 100)
  await crossfadeToImage(img, under, 'c', 0); decode(); await a
  expect(img.style.transition).toBe(''); expect(img.style.opacity).toBe('1')
  expect(img.src).toBe('c'); expect(under.src).toBe('')
  expect(under.classList.contains('hidden')).toBe(true)
})
