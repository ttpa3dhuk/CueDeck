import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled', webgl: 'enabled' }),
  },
}))
vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import type { OffscreenSharedTexture } from 'electron'
import { GpuTexturePublisher, retiredGpuPublisherCount, type GpuPaintSource } from '../src/main/syphon-gpu-publisher'

function texture(width = 1920, height = 1080) {
  let released = 0
  const value = {
    textureInfo: {
      widgetType: 'frame',
      pixelFormat: 'bgra',
      codedSize: { width, height },
      visibleRect: { x: 0, y: 0, width, height },
      contentRect: { x: 0, y: 0, width, height },
      timestamp: 1,
      metadata: {},
      sharedTextureHandle: Buffer.alloc(8, 1),
    },
    release: () => { released++ },
  } as unknown as OffscreenSharedTexture
  return { value, released: () => released }
}

function setup(target?: { width: number; height: number }) {
  const invalidate = vi.fn()
  const source: GpuPaintSource = {
    webContents: {
      isOffscreen: () => true,
      isPainting: () => true,
      getType: () => 'offscreen',
      getLastWebPreferences: () => ({ offscreen: true, sandbox: true }),
    } as any,
    isDestroyed: () => false,
    invalidate,
  }
  const native = {
    submit: vi.fn(() => ({ ok: true })),
    poll: vi.fn(() => null as null | { frameId: number; status: number; detail: number }),
    surfaceStride: vi.fn(() => 1920 * 4),
    destroy: vi.fn(),
  }
  const onFatal = vi.fn()
  const publisher = new GpuTexturePublisher({
    nativePath: '/tmp/none',
    name: 'test',
    isPublic: false,
    flipY: false,
    timeoutMs: 5000,
    firstTextureMs: 3000,
    ...(target ? { targetSize: target } : {}),
  }, () => source, onFatal)
  ;(publisher as any).native = native
  ;(publisher as any).gate.markReady()
  return { publisher, native, onFatal, invalidate }
}

function paint(publisher: GpuTexturePublisher, value: OffscreenSharedTexture | undefined): void {
  ;(publisher as any).onPaint({ texture: value })
}

beforeEach(() => vi.clearAllMocks())

describe('source-independent GPU publisher', () => {
  it('holds the submitted texture until native completion and releases a dropped texture immediately', () => {
    const { publisher, native, invalidate } = setup()
    const first = texture()
    const second = texture()
    paint(publisher, first.value)
    expect(native.submit).toHaveBeenCalledOnce()
    expect(first.released()).toBe(0)

    paint(publisher, second.value)
    expect(native.submit).toHaveBeenCalledOnce()
    expect(second.released()).toBe(1)

    native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
    expect((publisher as any).pollCompletion()).toBe(true)
    expect(first.released()).toBe(1)
    expect(invalidate).toHaveBeenCalled()
    publisher.destroyNow()
  })

  it('does not release a pending texture on timeout; a later completion releases it', () => {
    vi.useFakeTimers()
    try {
      const { publisher, native } = setup()
      const pending = texture()
      paint(publisher, pending.value)
      vi.advanceTimersByTime(6000)
      expect((publisher as any).stuck).toBe(true)
      expect(pending.released()).toBe(0)
      native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
      expect((publisher as any).pollCompletion()).toBe(true)
      expect(pending.released()).toBe(1)
      publisher.destroyNow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips transient software paints and fails at the first-texture deadline', () => {
    vi.useFakeTimers()
    try {
      const { publisher, onFatal } = setup()
      paint(publisher, undefined)
      expect(onFatal).not.toHaveBeenCalled()
      expect((publisher as any).missingTexturePaints).toBe(1)
      vi.advanceTimersByTime(3100)
      expect(onFatal).toHaveBeenCalledOnce()
      expect(String(onFatal.mock.calls[0][0])).toContain('no valid GPU texture')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails on a physical target-size mismatch instead of claiming 1920x1080', () => {
    const { publisher, native, onFatal } = setup({ width: 1920, height: 1080 })
    const wrong = texture(1280, 720)
    paint(publisher, wrong.value)
    expect(native.submit).not.toHaveBeenCalled()
    expect(wrong.released()).toBe(1)
    expect(onFatal).toHaveBeenCalledOnce()
    expect(String(onFatal.mock.calls[0][0])).toContain('does not match target 1920x1080')
  })

  it('holds a texture if disposed while native completion is still pending', () => {
    const { publisher, native } = setup()
    const pending = texture()
    paint(publisher, pending.value)
    native.poll.mockReturnValue(null)
    const before = retiredGpuPublisherCount()
    publisher.destroyNow()
    expect(pending.released()).toBe(0)
    expect(native.destroy).toHaveBeenCalled()
    expect(retiredGpuPublisherCount()).toBeGreaterThan(before)
  })

  it('releases the pending texture after native completion on every stop and keeps retired count flat', async () => {
    vi.useFakeTimers()
    try {
      const before = retiredGpuPublisherCount()
      for (let cycle = 0; cycle < 3; cycle++) {
        const { publisher, native } = setup()
        const pending = texture()
        paint(publisher, pending.value)
        const wait = publisher.stopAndWait(2000)
        expect(pending.released()).toBe(0)
        native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
        await vi.advanceTimersByTimeAsync(10)
        expect(await wait).toEqual({ released: true, timedOut: false })
        expect(pending.released()).toBe(1)
        expect(native.destroy).toHaveBeenCalled()
      }
      expect(retiredGpuPublisherCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a stop with no native completion, holds exactly one texture, and reports timeout', async () => {
    vi.useFakeTimers()
    try {
      const { publisher, native } = setup()
      const pending = texture()
      paint(publisher, pending.value)
      native.poll.mockReturnValue(null)
      const before = retiredGpuPublisherCount()
      const wait = publisher.stopAndWait(500)
      await vi.advanceTimersByTimeAsync(600)
      expect(await wait).toEqual({ released: false, timedOut: true })
      expect(pending.released()).toBe(0)
      expect(retiredGpuPublisherCount()).toBe(before + 1)
      expect(native.destroy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases a late paint immediately after stop', async () => {
    const { publisher } = setup()
    await publisher.stopAndWait(100)
    const late = texture()
    paint(publisher, late.value)
    expect(late.released()).toBe(1)
  })
})
