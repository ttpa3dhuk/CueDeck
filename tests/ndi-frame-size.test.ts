import { describe, expect, it } from 'vitest'
import { ndiFrameSize } from '../src/main/ndi/frame-size'
describe('NDI output bounds', () => {
  it('fits landscape and portrait into the selected resolution', () => {
    expect(ndiFrameSize(3840, 2160, 720)).toEqual({ width: 1280, height: 720 })
    expect(ndiFrameSize(1080, 1920, 720)).toEqual({ width: 404, height: 720 })
    expect(ndiFrameSize(3840, 2160, 2160)).toEqual({ width: 3840, height: 2160 })
  })
  it('does not upscale smaller source windows and rejects invalid sizes', () => {
    expect(ndiFrameSize(640, 360, 1080)).toEqual({ width: 640, height: 360 })
    expect(ndiFrameSize(NaN, 720, 720)).toBeNull()
    expect(ndiFrameSize(0, 720, 720)).toBeNull()
  })
})
