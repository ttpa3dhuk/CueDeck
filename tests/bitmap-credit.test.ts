import { describe, expect, it, vi } from 'vitest'
import { BitmapCredit } from '../src/shared/bitmap-credit'

describe('bitmap receiver credit', () => {
  it('bounds a stalled consumer without blocking another consumer', async () => {
    const slow = new BitmapCredit(), fast = new BitmapCredit()
    const make = vi.fn(async () => ({ close: vi.fn() })), failed = vi.fn()
    const slowSend = vi.fn(), fastSend = vi.fn()
    await slow.offer(make, slowSend, failed)
    for (let i = 0; i < 20; i++) {
      expect(await slow.offer(make, slowSend, failed)).toBe(false)
      await fast.offer(make, fastSend, failed)
      fast.acknowledge(fastSend.mock.calls.at(-1)![1])
    }
    expect(slowSend).toHaveBeenCalledOnce()
    expect(fastSend).toHaveBeenCalledTimes(20)
    expect(failed).not.toHaveBeenCalled()
  })
  it('does not grant credit to duplicate or stale acknowledgements', async () => {
    const c = new BitmapCredit(), send = vi.fn(), failed = vi.fn()
    const make = async () => ({ close: vi.fn() })
    await c.offer(make, send, failed)
    c.acknowledge(0); expect(c.busy).toBe(true)
    c.acknowledge(1); await c.offer(make, send, failed)
    c.acknowledge(1); expect(c.busy).toBe(true)
    c.acknowledge(2); expect(c.busy).toBe(false)
  })
  it('closes an asynchronously created frame after the source is retired', async () => {
    const c = new BitmapCredit(), frame = { close: vi.fn() }, send = vi.fn()
    let resolve!: (v: typeof frame) => void
    const pending = c.offer(() => new Promise(r => { resolve = r }), send, vi.fn())
    c.close(); resolve(frame)
    expect(await pending).toBe(false)
    expect(frame.close).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled()
  })
  it('closes the frame after a failed transfer and reports the failure once', async () => {
    const c = new BitmapCredit(), frame = { close: vi.fn() }, failed = vi.fn()
    await c.offer(async () => frame, () => { throw Error('closed port') }, failed)
    expect(frame.close).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce()
    expect(c.busy).toBe(false)
  })
})
