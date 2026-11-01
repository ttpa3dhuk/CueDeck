import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { NativeImage, WebContents } from 'electron'
import { acquireFrameTap } from '../src/main/frame-tap'

class FakeWebContents extends EventEmitter {
  destroyed = false
  callback: ((image: NativeImage, dirty: Electron.Rectangle) => void) | null = null
  beginFrameSubscription = vi.fn((_onlyDirty: boolean, callback: (image: NativeImage, dirty: Electron.Rectangle) => void) => {
    this.callback = callback
  })
  endFrameSubscription = vi.fn()
  isDestroyed = () => this.destroyed
  send(image: NativeImage): void {
    this.callback?.(image, { x: 0, y: 0, width: 1, height: 1 })
  }
}

function fake(): FakeWebContents {
  return new FakeWebContents()
}

function image(value: number): NativeImage {
  return { value } as unknown as NativeImage
}

describe('shared frame tap', () => {
  it('starts one Electron subscription and feeds every consumer', () => {
    const wc = fake()
    const a = vi.fn()
    const b = vi.fn()
    const leaseA = acquireFrameTap(wc as unknown as WebContents, 'a', a)
    const leaseB = acquireFrameTap(wc as unknown as WebContents, 'b', b)
    expect(wc.beginFrameSubscription).toHaveBeenCalledOnce()
    wc.send(image(1))
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    leaseA.release()
    expect(wc.endFrameSubscription).not.toHaveBeenCalled()
    leaseB.release()
    expect(wc.endFrameSubscription).toHaveBeenCalledOnce()
  })

  it('is idempotent and starts a fresh subscription after the last release', () => {
    const wc = fake()
    const lease = acquireFrameTap(wc as unknown as WebContents, 'owner', vi.fn())
    lease.release()
    lease.release()
    expect(wc.endFrameSubscription).toHaveBeenCalledOnce()
    const again = acquireFrameTap(wc as unknown as WebContents, 'owner', vi.fn())
    expect(wc.beginFrameSubscription).toHaveBeenCalledTimes(2)
    again.release()
    expect(wc.endFrameSubscription).toHaveBeenCalledTimes(2)
  })

  it('does not end a subscription that Electron already destroyed', () => {
    const wc = fake()
    const lease = acquireFrameTap(wc as unknown as WebContents, 'owner', vi.fn())
    wc.destroyed = true
    wc.emit('destroyed')
    lease.release()
    expect(wc.endFrameSubscription).not.toHaveBeenCalled()
  })

  it('keeps other consumers alive when one listener throws', () => {
    const wc = fake()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bad = vi.fn(() => { throw new Error('consumer bug') })
    const good = vi.fn()
    acquireFrameTap(wc as unknown as WebContents, 'bad', bad)
    acquireFrameTap(wc as unknown as WebContents, 'good', good)
    wc.send(image(2))
    expect(good).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('rejects duplicate owners instead of replacing a callback silently', () => {
    const wc = fake()
    acquireFrameTap(wc as unknown as WebContents, 'same', vi.fn())
    expect(() => acquireFrameTap(wc as unknown as WebContents, 'same', vi.fn()))
      .toThrow('already registered')
  })
})
