import { expect, it, vi } from 'vitest'
import type { AppState, SlideInteractiveScene } from '../src/shared/types'

vi.mock('../src/renderer/shared/animation-compositor', () => ({
  paintComposition: vi.fn(), sprite: vi.fn(() => ({})), invalidateComposition: vi.fn(),
}))
vi.mock('../src/renderer/shared/animation-client', () => ({
  AnimationFrames: class {}, renderForegroundPair: vi.fn(),
}))
vi.mock('../src/renderer/shared/video', () => ({ placeSlideOverlay: vi.fn() }))

import { SlideInteractive } from '../src/renderer/shared/slide-interactive'

it('rearms RAF when 120 Hz callbacks fall in the same 30 FPS frame', () => {
  const callbacks: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.push(callback)
    return callbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('DOMMatrix', class {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    translateSelf() { return this }
  })
  const canvas = () => ({ width: 16, height: 9, clientWidth: 16,
    classList: { add: vi.fn(), remove: vi.fn() }, dataset: {}, after: vi.fn(), setAttribute: vi.fn() })
  vi.stubGlobal('document', { createElement: canvas })
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.spyOn(Date, 'now').mockReturnValue(1000)

  const scene: SlideInteractiveScene = {
    file: 'actors.pdf', firstPage: 1,
    layers: [{ page: 2, shape: 'actor', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    triggers: [],
    autoEffects: [{ shape: 'actor', startMs: 0, durationMs: 2000,
      from: { x: 0, y: 0, opacity: 1 }, to: { x: 0, y: 0, opacity: 1 } }],
  }
  const state = { pdfSha1: 'deck', slideEnteredAt: 0 } as AppState
  let interactive!: SlideInteractive
  interactive = new SlideInteractive(canvas() as unknown as HTMLCanvasElement, () => interactive.update(scene, state))
  const request = { key: 'deck:1:16', abort: new AbortController(),
    base: canvas(), layers: [canvas()], status: 'ready' }
  ;(interactive as unknown as { request: typeof request }).request = request as typeof request
  try {
    interactive.update(scene, state)
    expect(callbacks).toHaveLength(1)
    callbacks.shift()!(0)
    expect(callbacks).toHaveLength(1)
    callbacks.shift()!(0)
    expect(callbacks).toHaveLength(1)
  } finally {
    interactive.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
