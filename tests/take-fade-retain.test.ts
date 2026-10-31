import { afterEach, expect, it, vi } from 'vitest'
import { TakeFade } from '../src/renderer/shared/take-fade'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('keeps the outgoing decoder through the invisible hold and releases only retired players', async () => {
  vi.useFakeTimers()
  const rect = { left: 0, top: 0, width: 640, height: 360 }
  class Video {
    style = {}; videoWidth = 640; videoHeight = 360; readyState = 4
    currentTime = 4.2; paused = false; muted = false; playsInline = false; loop = false
    srcObject = null; src = 'cuedeck-media://stream/program?v=first'
    getBoundingClientRect = () => rect
    pause = vi.fn(); play = vi.fn(async () => {}); load = vi.fn()
    remove = vi.fn(); removeAttribute = vi.fn(); addEventListener = vi.fn()
  }
  class Image {}
  const draws = vi.fn()
  let finishAnimation!: () => void
  class Canvas {
    width = 640; height = 360
    remove = vi.fn()
    animate = vi.fn(() => {
      let finish!: () => void
      const finished = new Promise<void>(resolve => { finish = resolve; finishAnimation = resolve })
      return { finished, cancel: finish }
    })
    getContext = () => ({ scale: vi.fn(), fillRect: vi.fn(), drawImage: draws,
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn() })
  }
  vi.stubGlobal('HTMLVideoElement', Video); vi.stubGlobal('HTMLImageElement', Image); vi.stubGlobal('HTMLCanvasElement', Canvas)
  vi.stubGlobal('devicePixelRatio', 1)
  const callbacks = new Map<number, FrameRequestCallback>(); let next = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { callbacks.set(++next, fn); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block', opacity: '1', objectFit: 'contain', clipPath: 'none' }))
  const create = vi.fn((tag: string) => { expect(tag).toBe('canvas'); return new Canvas() })
  vi.stubGlobal('document', { createElement: create })
  const first = new Video(), second = new Video(), third = new Video()
  let current = first
  const retained: Video[] = []
  const fade = new TakeFade({ getBoundingClientRect: () => rect, append: vi.fn() } as unknown as HTMLElement,
    () => [current as unknown as HTMLVideoElement], video => {
      retained.push(current); current = current === first ? second : third; return video
    })
  fade.begin({ id: 'first', durationMs: 400 }, true)
  expect(first.currentTime).toBe(4.2)
  expect(first.src).toBe('cuedeck-media://stream/program?v=first')
  expect(first.load).not.toHaveBeenCalled()
  expect(first.pause).not.toHaveBeenCalled()
  expect(first.muted).toBe(true)
  const reveal = fade.reveal({ id: 'first', durationMs: 400 }, () => true)
  const frame = create.mock.results[0].value
  expect(frame.animate).toHaveBeenCalledWith([
    { opacity: 1, offset: 0 }, { opacity: 0, offset: 400 / 600 }, { opacity: 0, offset: 1 },
  ], { duration: 600, easing: 'linear', fill: 'forwards' })
  expect(first.pause).not.toHaveBeenCalled()
  finishAnimation()
  await reveal
  expect(first.pause).toHaveBeenCalledOnce()
  fade.begin({ id: 'second', durationMs: 400 }, true)
  expect(retained).toEqual([first, second])
  expect(first.pause).toHaveBeenCalledOnce()
  expect(second.pause).not.toHaveBeenCalled()
  fade.cancel()
  expect(second.pause).toHaveBeenCalledOnce()
  expect(second.removeAttribute).toHaveBeenCalledWith('src')
  expect(second.load).toHaveBeenCalledOnce()
  expect(third.pause).not.toHaveBeenCalled()
  expect(third.load).not.toHaveBeenCalled()
})
