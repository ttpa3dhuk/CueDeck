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

function setup(target?: { width: number; height: number }, consumeFrame?: (info: OffscreenSharedTexture['textureInfo']) => Promise<void>) {
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
    requestClose: vi.fn(),
    isClosed: vi.fn(() => true),
    destroy: vi.fn(),
  }
  const onFatal = vi.fn()
  const onFirstCompletion = vi.fn()
  const publisher = new GpuTexturePublisher({
    nativePath: '/tmp/none',
    name: 'test',
    isPublic: false,
    flipY: false,
    timeoutMs: 5000,
    firstTextureMs: 3000,
    consumeFrame,
    ...(target ? { targetSize: target } : {}),
  }, () => source, onFatal, onFirstCompletion)
  ;(publisher as any).native = native
  ;(publisher as any).gate.markReady()
  return { publisher, native, onFatal, invalidate, onFirstCompletion }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function paint(publisher: GpuTexturePublisher, value: OffscreenSharedTexture | undefined): void {
  ;(publisher as any).onPaint({ texture: value })
}

beforeEach(() => vi.clearAllMocks())

describe('source-independent GPU publisher', () => {
  it('keeps native ACK cached until the mirror releases its references, then sends latest', async () => {
    const firstMirror = deferred()
    const secondMirror = deferred()
    const consume = vi.fn().mockReturnValueOnce(firstMirror.promise).mockReturnValueOnce(secondMirror.promise)
    const { publisher, native, onFirstCompletion } = setup(undefined, consume)
    const first = texture()
    const latest = texture()
    paint(publisher, first.value)
    paint(publisher, latest.value)
    native.poll.mockReturnValueOnce({ frameId: 1, status: 0, detail: 0 }).mockReturnValue(null)
    expect((publisher as any).pollCompletion()).toBe(false)
    expect(first.released()).toBe(0)
    expect(native.submit).toHaveBeenCalledOnce()
    expect(onFirstCompletion).not.toHaveBeenCalled()
    firstMirror.resolve()
    await firstMirror.promise
    await Promise.resolve()
    expect(first.released()).toBe(1)
    expect(native.poll).toHaveBeenCalledOnce()
    expect(native.submit).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenCalledTimes(2)
    expect(latest.released()).toBe(0)
    expect(onFirstCompletion).toHaveBeenCalledOnce()
    native.poll.mockReturnValue({ frameId: 2, status: 0, detail: 0 })
    secondMirror.resolve()
    await secondMirror.promise
    await Promise.resolve()
    expect(latest.released()).toBe(1)
    publisher.destroyNow()
  })

  it('waits for native completion when mirror finishes first', async () => {
    const mirror = deferred()
    const { publisher, native } = setup(undefined, () => mirror.promise)
    const frame = texture()
    paint(publisher, frame.value)
    mirror.resolve()
    await mirror.promise
    await Promise.resolve()
    expect(frame.released()).toBe(0)
    native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
    expect((publisher as any).pollCompletion()).toBe(true)
    expect(frame.released()).toBe(1)
    publisher.destroyNow()
  })

  it('waits for native completion after mirror rejection, then fails with detail', async () => {
    const mirror = deferred()
    const { publisher, native, onFatal } = setup(undefined, () => mirror.promise)
    const frame = texture()
    paint(publisher, frame.value)
    mirror.reject(new Error('allReferencesReleased failed'))
    await mirror.promise.catch(() => {})
    await Promise.resolve()
    expect(frame.released()).toBe(0)
    expect(onFatal).not.toHaveBeenCalled()
    native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
    expect((publisher as any).pollCompletion()).toBe(true)
    expect(frame.released()).toBe(1)
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining('allReferencesReleased failed'))
  })

  it('waits for mirror during stop after native ACK and releases unsent latest immediately', async () => {
    vi.useFakeTimers()
    try {
      const mirror = deferred()
      const { publisher, native } = setup(undefined, () => mirror.promise)
      const frame = texture()
      const latest = texture()
      paint(publisher, frame.value)
      paint(publisher, latest.value)
      native.poll.mockReturnValueOnce({ frameId: 1, status: 0, detail: 0 }).mockReturnValue(null)
      const stop = publisher.stopAndWait(1000)
      expect(latest.released()).toBe(1)
      expect(frame.released()).toBe(0)
      expect(native.requestClose).not.toHaveBeenCalled()
      mirror.resolve()
      await mirror.promise
      await vi.advanceTimersByTimeAsync(10)
      expect(await stop).toEqual({ released: true, timedOut: false })
      expect(frame.released()).toBe(1)
      expect(native.requestClose).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('holds the source on destroyNow until an already ACKed mirror finishes', async () => {
    const mirror = deferred()
    const { publisher, native } = setup(undefined, () => mirror.promise)
    const frame = texture()
    paint(publisher, frame.value)
    native.poll.mockReturnValueOnce({ frameId: 1, status: 0, detail: 0 }).mockReturnValue(null)
    const before = retiredGpuPublisherCount()
    publisher.destroyNow()
    expect(frame.released()).toBe(0)
    expect(retiredGpuPublisherCount()).toBe(before + 1)
    mirror.resolve()
    await mirror.promise
    await Promise.resolve()
    expect(frame.released()).toBe(1)
    expect(retiredGpuPublisherCount()).toBe(before)
  })

  it('bounds stop while only mirror is pending and keeps the source held', async () => {
    vi.useFakeTimers()
    try {
      const mirror = deferred()
      const { publisher, native } = setup(undefined, () => mirror.promise)
      const frame = texture()
      paint(publisher, frame.value)
      native.poll.mockReturnValueOnce({ frameId: 1, status: 0, detail: 0 }).mockReturnValue(null)
      const before = retiredGpuPublisherCount()
      const stop = publisher.stopAndWait(100)
      await vi.advanceTimersByTimeAsync(110)
      expect(await stop).toEqual({ released: false, timedOut: true })
      expect(frame.released()).toBe(0)
      expect(retiredGpuPublisherCount()).toBe(before + 1)
      mirror.resolve()
      await mirror.promise
      await Promise.resolve()
      expect(frame.released()).toBe(1)
      expect(retiredGpuPublisherCount()).toBe(before)
    } finally { vi.useRealTimers() }
  })

  it('releases the unsent latest frame on stop while holding the submitted frame until completion', async () => {
    vi.useFakeTimers()
    try {
      const { publisher, native } = setup()
      const submitted = texture()
      const latest = texture()
      paint(publisher, submitted.value)
      paint(publisher, latest.value)
      const stopping = publisher.stopAndWait(1000)
      expect(latest.released()).toBe(1)
      expect(submitted.released()).toBe(0)
      native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
      await vi.advanceTimersByTimeAsync(10)
      expect(await stopping).toEqual({ released: true, timedOut: false })
      expect(submitted.released()).toBe(1)
      expect(native.submit).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('waits for native sender withdrawal after the last frame before completing stop', async () => {
    vi.useFakeTimers()
    try {
      const { publisher, native } = setup()
      native.isClosed.mockReturnValue(false)
      let stopped = false
      const stopping = publisher.stopAndWait(1000).then((result) => { stopped = true; return result })
      await vi.advanceTimersByTimeAsync(100)
      expect(native.requestClose).toHaveBeenCalledOnce()
      expect(stopped).toBe(false)
      expect(native.destroy).not.toHaveBeenCalled()
      native.isClosed.mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(10)
      expect(await stopping).toEqual({ released: true, timedOut: false })
      expect(native.destroy).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('announces a working output only after the native GPU completion, once per producer', () => {
    const { publisher, native, onFirstCompletion } = setup()
    paint(publisher, texture().value)
    expect(onFirstCompletion).not.toHaveBeenCalled()
    native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
    ;(publisher as any).pollCompletion()
    expect(onFirstCompletion).toHaveBeenCalledOnce()
    paint(publisher, texture().value)
    native.poll.mockReturnValue({ frameId: 2, status: 0, detail: 0 })
    ;(publisher as any).pollCompletion()
    expect(onFirstCompletion).toHaveBeenCalledOnce()
    publisher.destroyNow()
  })

  it('holds the latest busy frame and submits it after completion without relying on another capture', () => {
    const { publisher, native } = setup()
    const first = texture()
    const second = texture()
    paint(publisher, first.value)
    expect(native.submit).toHaveBeenCalledOnce()
    expect(first.released()).toBe(0)

    paint(publisher, second.value)
    expect(native.submit).toHaveBeenCalledOnce()
    expect(second.released()).toBe(0)
    const third = texture()
    paint(publisher, third.value)
    expect(second.released()).toBe(1)

    native.poll.mockReturnValue({ frameId: 1, status: 0, detail: 0 })
    expect((publisher as any).pollCompletion()).toBe(true)
    expect(first.released()).toBe(1)
    expect(native.submit).toHaveBeenCalledTimes(2)
    expect(third.released()).toBe(0)
    native.poll.mockReturnValue({ frameId: 2, status: 0, detail: 0 })
    ;(publisher as any).pollCompletion()
    expect(third.released()).toBe(1)
    publisher.destroyNow()
  })

  it('does not release a pending texture on timeout; a later completion releases it', () => {
    vi.useFakeTimers()
    try {
      const { publisher, native, onFatal } = setup()
      const pending = texture()
      paint(publisher, pending.value)
      vi.advanceTimersByTime(6000)
      expect((publisher as any).stuck).toBe(true)
      expect(onFatal).toHaveBeenCalledWith(expect.stringContaining('completion timeout'))
      expect(publisher.status().failed).toBe(true)
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
