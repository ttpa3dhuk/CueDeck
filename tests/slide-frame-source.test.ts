import { describe, expect, it, vi } from 'vitest'
import { SlideFrameSource, type SlideFrameKey } from '../packages/render-core/src/frame-source'

const key = (page = 1, document = 'a', width = 2): SlideFrameKey => ({ document, page, width, height: 2, rotation: 0 })
const frame = () => ({ byteLength: 16, close: vi.fn() })
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function setup(budget = 128) {
  const render = vi.fn(async () => frame())
  const dispose = vi.fn(async () => undefined)
  const source = new SlideFrameSource({ render, dispose }, budget)
  return { source, render, dispose }
}

describe('shared slide frame source', () => {
  it('retires one document while a borrowed raster and the other cache remain valid', async () => {
    const { source, render } = setup()
    const old = await source.request('old', key(), 'program')
    const other = await source.request('other', key(1, 'b'), 'preview')
    other!.release()
    source.invalidateDocument('a')
    expect(old!.frame.close).not.toHaveBeenCalled()
    const hit = await source.request('hit', key(1, 'b'), 'program')
    hit!.release()
    const replacement = await source.request('replacement', key(), 'program')
    expect(render).toHaveBeenCalledTimes(3)
    expect(source.residentBytes).toBe(48)
    old!.release()
    expect(source.residentBytes).toBe(32)
    expect(old!.frame.close).toHaveBeenCalledOnce()
    replacement!.release(); await source.stop()
    expect(source.residentBytes).toBe(0)
  })
  it('deduplicates concurrent consumers and keeps the raster until all release', async () => {
    const { source, render } = setup()
    const [a, b] = await Promise.all([source.request('pgm', key(), 'program'), source.request('hall', key(), 'program')])
    expect(render).toHaveBeenCalledTimes(1)
    expect(a?.frame).toBe(b?.frame)
    await source.stop()
    a!.release()
    expect(a!.frame.close).not.toHaveBeenCalled()
    b!.release(); b!.release()
    expect(a!.frame.close).toHaveBeenCalledTimes(1)
    expect(source.residentBytes).toBe(0)
  })

  it('renders program before queued prefetch and shares cache hits', async () => {
    const { source, render } = setup()
    const prefetch = source.request('next', key(2), 'prefetch')
    const pgm = await source.request('pgm', key(), 'program')
    pgm!.release()
    const next = await prefetch
    next!.release()
    expect(render.mock.calls.map(call => (call as unknown as [SlideFrameKey])[0].page)).toEqual([1, 2])
    const hit = await source.request('hall', key(), 'program')
    expect(render).toHaveBeenCalledTimes(2)
    hit!.release(); await source.stop()
  })

  it('drops obsolete queued pages before touching backend', async () => {
    const { source, render } = setup()
    const first = source.request('pgm', key(), 'program')
    const latest = source.request('pgm', key(3), 'program')
    expect(await first).toBeNull()
    const lease = await latest
    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0]).toEqual([key(3), expect.any(AbortSignal)])
    lease!.release(); await source.stop()
  })

  it('does not abort a shared job when one consumer closes', async () => {
    const { source, render } = setup()
    const first = source.request('pgm', key(), 'program')
    const second = source.request('hall', key(), 'program')
    source.cancel('pgm')
    expect(await first).toBeNull()
    const lease = await second
    expect((render.mock.calls[0] as unknown as [unknown, AbortSignal])[1].aborted).toBe(false)
    lease!.release(); await source.stop()
  })

  it('closes a late cancelled raster and runs the replacement serially', async () => {
    const { source, render } = setup()
    const late = frame()
    let finish!: (value: ReturnType<typeof frame>) => void
    render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = source.request('pgm', key(), 'program')
    await tick()
    const replacement = source.request('pgm', key(2), 'program')
    expect(await old).toBeNull()
    expect(render).toHaveBeenCalledTimes(1)
    finish(late)
    const lease = await replacement
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(2)
    lease!.release(); await source.stop()
  })

  it('accounts pinned memory and rejects backpressure without destroying a reader', async () => {
    const { source, render } = setup(16)
    const lease = await source.request('slow', key(), 'program')
    await expect(source.request('pgm', key(2), 'program')).rejects.toThrow('pinned')
    expect(lease!.frame.close).not.toHaveBeenCalled()
    expect(render).toHaveBeenCalledTimes(1)
    lease!.release()
    const second = await source.request('pgm', key(2), 'program')
    expect(lease!.frame.close).toHaveBeenCalledTimes(1)
    expect(source.residentBytes).toBe(16)
    second!.release(); await source.stop()
  })

  it('requires acknowledgement before the next request by the same consumer', async () => {
    const { source } = setup()
    const lease = await source.request('slow', key(), 'program')
    await expect(source.request('slow', key(2), 'program')).rejects.toThrow('release')
    lease!.release(); await source.stop()
  })

  it('keys distinct documents, dimensions and rotation separately', async () => {
    const render = vi.fn(async (k: SlideFrameKey) => ({ byteLength: k.width * k.height * 4, close() {} }))
    const source = new SlideFrameSource({ render, async dispose() {} })
    for (const k of [key(), key(1, 'b'), key(1, 'a', 3), { ...key(), rotation: 90 as const }]) {
      const lease = await source.request('pgm', k, 'program'); lease!.release()
    }
    expect(render).toHaveBeenCalledTimes(4)
    await source.stop()
  })

  it('keeps static frames and different animation sample times distinct', async () => {
    const { source, render } = setup()
    for (const request of [key(), { ...key(), timeUs: 0 }, { ...key(), timeUs: 1000 }]) {
      const lease = await source.request('pgm', request, 'program'); lease!.release()
    }
    expect(render).toHaveBeenCalledTimes(3)
    await expect(source.request('pgm', { ...key(), timeUs: -1 }, 'program')).rejects.toThrow('Invalid')
    await source.stop()
  })

  it('recovers after backend failure and rejects a wrong allocation', async () => {
    const { source, render } = setup()
    render.mockRejectedValueOnce(new Error('decode failed'))
    await expect(source.request('pgm', key(), 'program')).rejects.toThrow('decode failed')
    const wrong = { byteLength: 20, close: vi.fn() }
    render.mockResolvedValueOnce(wrong)
    await expect(source.request('pgm', key(), 'program')).rejects.toThrow('unexpected')
    expect(wrong.close).toHaveBeenCalledOnce()
    const lease = await source.request('pgm', key(), 'program')
    lease!.release(); await source.stop()
  })

  it('stops pending work and waits for in-flight completion before disposing', async () => {
    const { source, render, dispose } = setup()
    let finish!: (value: ReturnType<typeof frame>) => void
    render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = source.request('pgm', key(), 'program')
    await tick()
    const queued = source.request('next', key(2), 'prefetch')
    const stopped = source.stop()
    expect(await first).toBeNull(); expect(await queued).toBeNull()
    expect(dispose).not.toHaveBeenCalled()
    const late = frame(); finish(late)
    await stopped
    expect(dispose).toHaveBeenCalledOnce()
    expect(late.close).toHaveBeenCalledOnce()
    expect(source.stop()).toBe(stopped)
    expect(await source.request('pgm', key(), 'program')).toBeNull()
  })

  it('bounds consumers and rejects invalid sizes before rendering', async () => {
    const backend = { async render() { return frame() }, async dispose() {} }
    const source = new SlideFrameSource(backend, 32, 1)
    const one = source.request('one', key(), 'program')
    await expect(source.request('two', key(), 'program')).rejects.toThrow('limit')
    const lease = await one
    lease!.release()
    await expect(source.request('one', { ...key(), width: Infinity }, 'program')).rejects.toThrow('Invalid')
    await expect(source.request('one', key(1, 'a', 8), 'program')).rejects.toThrow('exceeds')
    await source.stop()
  })
})
