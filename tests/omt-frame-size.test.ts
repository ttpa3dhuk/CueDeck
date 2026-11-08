import { describe, expect, it } from 'vitest'
import { omtFrameSize } from '../src/shared/omt-frame-size'

describe('OMT frame limits', () => {
  it.each([
    [1080, 1920, 1080, 608, 1080],
    [3840, 2160, 1080, 1920, 1080],
    [1920, 1920, 1080, 1080, 1080],
    [3840, 1080, 1080, 1920, 540],
    [1920, 1080, 1080, 1920, 1080],
    [640, 480, 1080, 640, 480],
    [1080, 1920, 720, 405, 720],
    [1920, 1080, 720, 1280, 720],
  ] as const)('fits %i×%i into %ip without cropping or upscaling', (w, h, resolution, expectedW, expectedH) => {
    expect(omtFrameSize(w, h, resolution)).toEqual({ width: expectedW, height: expectedH })
  })
  it('keeps both bounds and aspect within pixel rounding for varied source frames', () => {
    for (const resolution of [720, 1080] as const) {
      for (const width of [17, 601, 1080, 1919, 3840, 8192]) {
        for (const height of [17, 719, 1080, 1920, 4320, 8192]) {
          const size = omtFrameSize(width, height, resolution)!
          expect(size.width).toBeLessThanOrEqual(Math.min(width, resolution * 16 / 9))
          expect(size.height).toBeLessThanOrEqual(Math.min(height, resolution))
          const scale = Math.min(1, resolution * 16 / 9 / width, resolution / height)
          expect(Math.abs(size.width - width * scale)).toBeLessThanOrEqual(.5)
          expect(Math.abs(size.height - height * scale)).toBeLessThanOrEqual(.5)
        }
      }
    }
  })
  it.each([[0, 100], [100, -1], [NaN, 100], [100, Infinity]])('rejects invalid dimensions %s×%s', (w, h) => {
    expect(omtFrameSize(w, h, 1080)).toBeNull()
  })
})
