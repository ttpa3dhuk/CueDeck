import { afterEach, expect, it, vi } from 'vitest'
import { GifPlayer } from '../src/renderer/shared/gif-player'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function setup(repetitions = 1) {
  const frames: {close: ReturnType<typeof vi.fn>}[] = [], indexes: number[] = []
  const buffers = new Set<unknown>()
  let closed = false
  class Decoder {
    tracks = {ready: Promise.resolve(), selectedTrack: {frameCount: 3, repetitionCount: repetitions}}
    decode = vi.fn(async ({frameIndex}: {frameIndex: number}) => {
      expect(closed).toBe(false)
      expect(frames.every(f => f.close.mock.calls.length === 1)).toBe(true)
      indexes.push(frameIndex)
      const image = {displayWidth: 600, displayHeight: 513, duration: 100000,
        copyTo: vi.fn(async (destination: unknown) => { buffers.add(destination); return [] }), close: vi.fn()}
      frames.push(image); return {image}
    })
    close() { closed = true }
  }
  vi.stubGlobal('ImageDecoder', Decoder)
  vi.stubGlobal('ImageData', class {
    data: Uint8ClampedArray
    constructor(readonly width: number, readonly height: number) {this.data=new Uint8ClampedArray(width*height*4)}
  })
  const canvas = {width: 0, height: 0, dataset: {}, getContext: () => ({putImageData: vi.fn()})} as unknown as HTMLCanvasElement
  return {canvas, frames, indexes, buffers, isClosed: () => closed}
}

it('honors frame delays and finite repeats, closing each frame before decoding the next', async () => {
  vi.useFakeTimers()
  const s = setup(), player = new GifPlayer(s.canvas)
  await player.start(new Uint8Array([1]))
  expect(player.ready).toBe(true)
  expect(s.indexes).toEqual([0])
  await vi.advanceTimersByTimeAsync(500)
  expect(s.indexes).toEqual([0,1,2,0,1,2])
  await vi.advanceTimersByTimeAsync(1000)
  expect(s.indexes).toHaveLength(6)
  expect(s.frames.every(f => f.close.mock.calls.length === 1)).toBe(true)
  expect(s.buffers.size).toBe(1)
  player.stop()
  expect(s.isClosed()).toBe(true); expect(s.canvas.width).toBe(0)
})

it('cancels scheduled decoding and closes a frame that arrives after removal', async () => {
  vi.useFakeTimers()
  const s = setup(Infinity)
  let finish!: (value: unknown) => void
  const image = {displayWidth: 600, displayHeight: 513, close: vi.fn()}
  vi.stubGlobal('ImageDecoder', class {
    tracks = {ready: Promise.resolve(), selectedTrack: {frameCount: 81, repetitionCount: Infinity}}
    decode = () => new Promise(resolve => { finish = resolve })
    close = vi.fn()
  })
  const player = new GifPlayer(s.canvas), start = player.start(new Uint8Array([1]))
  await Promise.resolve(); player.stop(); finish({image}); await start
  expect(image.close).toHaveBeenCalledOnce()
  expect(s.canvas.width).toBe(0); expect(player.ready).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
