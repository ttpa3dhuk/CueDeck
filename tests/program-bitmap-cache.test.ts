import type { NativeImage } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { clearProgramBitmapCache, programBitmap } from '../src/main/program-bitmap-cache'

function image(width: number, height: number, copies: ReturnType<typeof vi.fn>, bytes = width * height * 4): NativeImage {
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => { copies(); return Buffer.allocUnsafe(bytes) },
    resize: ({ width: w, height: h }: { width: number; height: number }) => image(w, h, copies),
  } as unknown as NativeImage
}

afterEach(clearProgramBitmapCache)

it('shares one immutable bitmap for the same program image and target size', () => {
  const copies = vi.fn(), source = image(1920, 1080, copies)
  const ndi = programBitmap(source, 1920, 1080)
  const omt = programBitmap(source, 1920, 1080)
  expect(omt.bitmap).toBe(ndi.bitmap)
  expect(copies).toHaveBeenCalledOnce()
  programBitmap(source, 1280, 720)
  expect(copies).toHaveBeenCalledTimes(2)
  clearProgramBitmapCache()
  programBitmap(source, 1920, 1080)
  expect(copies).toHaveBeenCalledTimes(3)
})

it('evicts old high-resolution bitmaps under the absolute byte cap', () => {
  const copies = vi.fn(), a = image(32, 18, copies, 40 * 1024 * 1024)
  const b = image(32, 18, copies, 40 * 1024 * 1024)
  programBitmap(a, 32, 18)
  programBitmap(b, 32, 18)
  programBitmap(a, 32, 18)
  expect(copies).toHaveBeenCalledTimes(3)
})
