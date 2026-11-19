/** Immutable prepared assets; bound encoded bytes independently of decoder surfaces. */
export class GifByteCache {
  private entries = new Map<string, Uint8Array>()
  private pending = new Map<string, Promise<Uint8Array | null>>()
  constructor(private budget = 24 * 1024 * 1024) {}

  stats(): {bytes: number; entries: number; inflight: number} {
    return {bytes: [...this.entries.values()].reduce((n, data) => n + data.byteLength, 0), entries: this.entries.size, inflight: this.pending.size}
  }

  read(key: string, load: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached)
      return Promise.resolve(cached)
    }
    const pending = this.pending.get(key)
    if (pending) return pending
    const promise = load().then(bytes => {
      if (bytes && bytes.byteLength <= this.budget) {
        this.entries.set(key, bytes)
        while (this.stats().bytes > this.budget) this.entries.delete(this.entries.keys().next().value!)
      }
      return bytes
    }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key) })
    this.pending.set(key, promise)
    return promise
  }
}
