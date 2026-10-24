import { afterEach, expect, it, vi } from 'vitest'
import { TakeFade } from '../src/renderer/shared/take-fade'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  const frames: Array<{ remove: ReturnType<typeof vi.fn>; animate: ReturnType<typeof vi.fn> }> = []
  const callbacks = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback); return next
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('getComputedStyle', () => ({ opacity: '1' }))
  vi.stubGlobal('document', { createElement: () => {
    const frame = { remove: vi.fn(), animate: vi.fn(), getContext: () => ({
      scale: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
    }) }
    frames.push(frame)
    return frame
  } })
  const host = { getBoundingClientRect: () => ({ width: 640, height: 360 }), append: vi.fn() }
  const fade = new TakeFade(host as unknown as HTMLElement, [])
  const tick = async () => {
    const pending = [...callbacks.values()]; callbacks.clear()
    for (const callback of pending) callback(0)
    await Promise.resolve()
  }
  return { fade, frames, tick }
}

it('keeps a slide cut covered until decoding is ready, then cuts without an animation', async () => {
  const { fade, frames, tick } = fixture()
  const event = { id: 'cut', durationMs: 0, scope: 'slide' as const }
  let ready = false
  fade.begin(event)
  const reveal = fade.reveal(event, () => ready)
  await tick()
  expect(frames[0].remove).not.toHaveBeenCalled()
  ready = true
  await tick(); await reveal
  expect(frames[0].remove).toHaveBeenCalledOnce()
  expect(frames[0].animate).not.toHaveBeenCalled()
})

it('does not let an obsolete decoder reveal a newer slide during rapid cuts', async () => {
  const { fade, frames, tick } = fixture()
  const first = { id: 'first', durationMs: 0, scope: 'slide' as const }
  const second = { ...first, id: 'second' }
  fade.begin(first)
  const oldWait = fade.reveal(first, () => false)
  fade.begin(second)
  const currentWait = fade.reveal(second, () => false)
  await tick(); await oldWait
  expect(frames[0].remove).toHaveBeenCalledOnce()
  expect(frames[1].remove).not.toHaveBeenCalled()
  fade.cancel()
  await tick(); await currentWait
  expect(frames[1].remove).toHaveBeenCalledOnce()
})

it('releases a stalled cut and cancels ordinary file opens without retaining stale pictures', () => {
  const { fade, frames } = fixture()
  const event = { id: 'cut', durationMs: 0, scope: 'slide' as const }
  fade.begin(event)
  vi.advanceTimersByTime(10000)
  expect(frames[0].remove).toHaveBeenCalledOnce()
  fade.begin({ ...event, id: 'next' })
  fade.begin(null)
  expect(frames[1].remove).toHaveBeenCalledOnce()
})
