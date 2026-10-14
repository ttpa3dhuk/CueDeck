import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  pending: [] as ((error: unknown, pointer: unknown) => void)[],
  create: vi.fn(), destroy: vi.fn(), tally: vi.fn(),
  view: vi.fn(() => { throw new Error('External buffers forbidden in Electron') }),
  receive: Object.assign(vi.fn(), { async: vi.fn() }),
}))
import type { OmtLib } from '../src/main/omt/libomt-native.js'
function library(): OmtLib {
  return {
    receiveCreate: fake.create, receiveDestroy: fake.destroy,
    receiveSetTally: fake.tally, receive: fake.receive,
    koffi: {
      array: (_type: string, length: number, hint: string) => ({ length, hint }),
      decode: (pointer: unknown, type: unknown) => typeof type === 'string' ? pointer : new Uint8Array((pointer as ArrayBuffer).slice(0)),
      view: fake.view,
    },
  } as unknown as OmtLib
}
import { OmtInputManager } from '../src/main/omt/inputs.js'

const address = 'HOST (CueDeck Audience)'
const video = (data: ArrayBuffer) => ({
  Type: 2, Timestamp: 1000n, Codec: 0x41524742, Width: 2, Height: 1, Stride: 8, Flags: 0,
  FrameRateN: 30, FrameRateD: 1, Data: data, DataLength: data.byteLength,
})
let manager: OmtInputManager
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fake.pending = []
  fake.create.mockImplementation(() => ({}))
  fake.receive.async.mockImplementation((_handle, _types, _timeout, callback) => fake.pending.push(callback))
  manager = new OmtInputManager(library, vi.fn())
})
afterEach(() => {
  manager.destroy()
  for (const callback of fake.pending.splice(0)) callback(null, null)
  vi.useRealTimers()
})

describe('OMT native input lifecycle', () => {
  it('loads the injected library lazily and reports provider failures without creating a receiver', () => {
    const provider = vi.fn(() => { throw new Error('Unavailable native library') })
    manager = new OmtInputManager(provider, vi.fn())
    expect(provider).not.toHaveBeenCalled()
    expect(() => manager.retain(1, [address], vi.fn())).toThrow('Unavailable native library')
    expect(fake.create).not.toHaveBeenCalled()
  })

  it('uploads native video before libomt reuses it without copying pixels into JS', () => {
    const received = vi.fn(), texture = { type: 'video' as const, data: new Uint8Array(0), width: 2, height: 1, stride: 8, flags: 0, timestamp: 1000, frameRateN: 30, frameRateD: 1, texture: { id: 1, handle: '100', owner: 123 } }
    const upload = vi.fn(() => texture), finished = vi.fn()
    manager.destroy()
    manager = new OmtInputManager(library, vi.fn(), upload, finished)
    manager.retain(1, [address], received)
    vi.advanceTimersByTime(0)
    const native = video(new Uint8Array(8).buffer)
    fake.pending.shift()!(null, native)
    expect(upload).toHaveBeenCalledWith(native, address)
    expect(received).toHaveBeenCalledWith(address, texture)
    expect(finished).toHaveBeenCalledWith(texture)
    expect(texture.data.byteLength).toBe(0)
  })

  it('shares a receiver and copies video before native memory is reused', () => {
    const first = vi.fn(), second = vi.fn()
    manager.retain(1, [address], first)
    manager.retain(2, [address], second)
    expect(fake.create).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(0)
    expect(fake.receive.async).toHaveBeenCalledWith(expect.anything(), 6, 0, expect.any(Function))
    const native = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255])
    fake.pending.shift()!(null, video(native.buffer))
    native.fill(0)
    expect([...first.mock.calls[0][1].data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
    expect(second).toHaveBeenCalledTimes(1)
    expect(fake.view).not.toHaveBeenCalled()
    manager.release(1)
    expect(fake.destroy).not.toHaveBeenCalled()
    manager.release(2)
    expect(fake.destroy).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight native call before destroying the receiver', () => {
    const handler = vi.fn()
    manager.retain(1, [address], handler)
    vi.advanceTimersByTime(0)
    manager.release(1)
    expect(fake.destroy).not.toHaveBeenCalled()
    fake.pending.shift()!(null, video(new ArrayBuffer(8)))
    expect(fake.destroy).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps audio planar, copies it and removes invalid samples', () => {
    const handler = vi.fn()
    manager.retain(1, [address], handler)
    vi.advanceTimersByTime(0)
    const native = new Float32Array([0.1, 0.2, 0.3, NaN])
    fake.pending.shift()!(null, {
      Type: 4, Timestamp: 2000, Codec: 0x31415046, SampleRate: 48000,
      Channels: 2, SamplesPerChannel: 2, Data: native.buffer, DataLength: 16,
    })
    native.fill(0)
    expect(handler.mock.calls[0][1].data[0]).toBeCloseTo(0.1)
    expect(handler.mock.calls[0][1].data[2]).toBeCloseTo(0.3)
    expect(handler.mock.calls[0][1].data[3]).toBe(0)
    expect(fake.view).not.toHaveBeenCalled()
  })

  it('rejects truncated video without reading its native buffer', () => {
    const handler = vi.fn()
    manager.retain(1, [address], handler)
    vi.advanceTimersByTime(0)
    fake.pending.shift()!(null, video(new ArrayBuffer(4)))
    expect(handler).not.toHaveBeenCalled()
  })

  it('rolls back partially created receivers when native creation fails', () => {
    fake.create.mockReturnValueOnce({}).mockReturnValueOnce(null)
    expect(() => manager.retain(1, [address, 'HOST (Second)'], vi.fn())).toThrow('could not be created')
    expect(fake.destroy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(0)
    expect(fake.receive.async).not.toHaveBeenCalled()
  })
})
