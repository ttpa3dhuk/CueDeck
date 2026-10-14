import { afterEach, expect, it, vi } from 'vitest'
import { LiveView } from '../src/renderer/shared/live-stream'
import { makeLiveUri, parseLiveUri, normalizeWindowFps } from '../src/shared/live'

vi.mock('../src/renderer/shared/omt-stream', () => ({ OmtStream: vi.fn() }))

afterEach(() => vi.unstubAllGlobals())

it('keeps only one FPS callback when the stream changes repeatedly', () => {
  const callbacks = new Map<number, (now: number) => void>()
  let next = 0
  const el: any = { srcObject: null, classList: { remove() {}, toggle() {} }, play: async () => {},
    requestVideoFrameCallback: (cb: (now: number) => void) => { callbacks.set(++next, cb); return next },
    cancelVideoFrameCallback: (id: number) => callbacks.delete(id) }
  let stream = {}
  const pool: any = { stateOf: () => ({ status: 'live', message: null }), get: () => stream }
  const view = new LiveView(el, pool)
  for (let i = 0; i < 5; i++) { stream = {}; view.show('live://window?v=Test'); expect(callbacks.size).toBe(1) }
  for (let frame = 1; frame <= 61; frame++) {
    const [id, cb] = [...callbacks][0]; callbacks.delete(id); cb(frame * 1000 / 30)
    expect(callbacks.size).toBe(1)
  }
  expect(view.fps()).toBeLessThanOrEqual(31)
})

it('persists a per-window frame rate and reads old projects at 30 fps', () => {
  const src = { kind: 'window' as const, videoLabel: 'grandMA2', audioLabel: null, windowFps: 25 }
  expect(parseLiveUri(makeLiveUri(src))?.windowFps).toBe(25)
  expect(normalizeWindowFps(parseLiveUri('live://window?v=Old')?.windowFps)).toBe(30)
  expect(normalizeWindowFps(200)).toBe(60)
  expect(normalizeWindowFps(NaN)).toBe(30)
})

it('limits crop drawing and output rate even if input callbacks run at 100 fps', async () => {
  const { cropWindowStream } = await import('../src/renderer/shared/window-crop')
  let callback: (now: number) => void = () => {}
  const drawImage = vi.fn(), requestFrame = vi.fn(), stop = vi.fn()
  const output = { getVideoTracks: () => [{ requestFrame }] }
  const video: any = { videoWidth: 1920, videoHeight: 1080, style: {}, play: async () => {}, pause() {}, remove() {},
    requestVideoFrameCallback: (cb: (now: number) => void) => { callback = cb; return 1 }, cancelVideoFrameCallback: vi.fn() }
  const canvas: any = { width: 0, height: 0, getContext: () => ({ drawImage }), captureStream: vi.fn(() => output) }
  vi.stubGlobal('document', { createElement: (tag: string) => tag === 'video' ? video : canvas, body: { append() {} } })
  vi.stubGlobal('performance', { now: () => 0 })
  const raw: any = { getTracks: () => [{ stop }] }
  const cropped = await cropWindowStream(raw, { top: 0, right: 0, bottom: 0, left: 0 }, 25)
  for (let now = 10; now <= 1000; now += 10) callback(now)
  expect(canvas.captureStream).toHaveBeenCalledWith(25)
  expect(drawImage).toHaveBeenCalledTimes(26)
  cropped.dispose(); callback(1040)
  expect(drawImage).toHaveBeenCalledTimes(26)
  expect(stop).toHaveBeenCalledOnce()
})
