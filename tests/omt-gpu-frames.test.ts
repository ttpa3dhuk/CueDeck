import { describe, expect, it, vi } from 'vitest'
import { OmtGpuFrames } from '../src/main/omt/gpu-frames'
import type { NativeFrame } from '../src/main/omt/inputs'
const frame: NativeFrame = { Type: 2, Timestamp: 1000, Codec: 0x41524742, Width: 2, Height: 2, Stride: 8, Flags: 0,
  FrameRateN: 25, FrameRateD: 1, SampleRate: 0, Channels: 0, SamplesPerChannel: 0, Data: {}, DataLength: 16 }
function backend() { const textures: { handle: string; dispose: ReturnType<typeof vi.fn> }[] = []
  return { textures, close: vi.fn(), makeTexture: vi.fn(() => { const texture = { handle: '123', dispose: vi.fn() }; textures.push(texture); return texture }) } }
describe('bounded immutable OMT GPU frames', () => {
  it('keeps one native texture for all consumers and releases it after the last consumer', () => {
    const device = backend(), frames = new OmtGpuFrames(device), video = frames.create(frame, 'HOST (A)')!
    expect(video.data.byteLength).toBe(0)
    expect(device.makeTexture).toHaveBeenCalledWith(2, 2, frame.Data, 8)
    frames.retain(video.texture!.id); frames.retain(video.texture!.id)
    frames.discardUnused(video)
    expect(device.textures[0].dispose).not.toHaveBeenCalled()
    frames.release(video.texture!.id)
    expect(device.textures[0].dispose).not.toHaveBeenCalled()
    frames.release(video.texture!.id); frames.release(video.texture!.id)
    expect(device.textures[0].dispose).toHaveBeenCalledOnce()
    frames.close(); expect(device.close).toHaveBeenCalledOnce()
  })
  it('bounds each source and frees unused frames when every delivery was skipped', () => {
    const device = backend(), frames = new OmtGpuFrames(device)
    const videos = Array.from({ length: 5 }, () => frames.create(frame, 'HOST (A)')!)
    expect(frames.create(frame, 'HOST (A)')).toBeNull()
    frames.discardUnused(videos[0])
    expect(frames.create(frame, 'HOST (A)')).not.toBeNull()
    frames.close()
    expect(device.textures.every(t => t.dispose.mock.calls.length === 1)).toBe(true)
  })
  it('preserves alpha through the copied path and falls back when GPU delivery is disabled', () => {
    const device = backend(), frames = new OmtGpuFrames(device)
    expect(frames.create({ ...frame, Flags: 2 }, 'HOST (A)')).toBeUndefined()
    frames.disable()
    expect(frames.create(frame, 'HOST (A)')).toBeUndefined()
    expect(device.makeTexture).not.toHaveBeenCalled()
    frames.close()
  })
})
