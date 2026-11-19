import { expect, it, vi } from 'vitest'
import { GifByteCache } from '../src/renderer/shared/gif-byte-cache'

it('shares pending and cached bytes across returning players instead of copying them again', async () => {
  const cache = new GifByteCache(8), bytes = new Uint8Array(4), load = vi.fn(async () => bytes)
  const a = cache.read('sha:file', load), b = cache.read('sha:file', load)
  expect(a).toBe(b); expect(await a).toBe(bytes)
  expect(await cache.read('sha:file', load)).toBe(bytes)
  expect(load).toHaveBeenCalledOnce()
  expect(cache.stats()).toEqual({bytes: 4, entries: 1, inflight: 0})
})
it('evicts least recently used bytes, retries failed reads, and does not retain oversized assets', async () => {
  const cache = new GifByteCache(8), load = vi.fn(async () => new Uint8Array(4))
  await cache.read('a',load); await cache.read('b',load); await cache.read('a',load); await cache.read('c',load)
  expect(cache.stats().bytes).toBe(8)
  await cache.read('b',load); expect(load).toHaveBeenCalledTimes(4)
  const large=vi.fn(async () => new Uint8Array(9))
  await cache.read('large',large); await cache.read('large',large)
  expect(large).toHaveBeenCalledTimes(2); expect(cache.stats().bytes).toBe(8)
  await expect(cache.read('error',async()=>{throw new Error('read failed')})).rejects.toThrow('read failed')
  expect(await cache.read('error',async()=>new Uint8Array(1))).toHaveLength(1)
  expect(cache.stats().inflight).toBe(0)
})
