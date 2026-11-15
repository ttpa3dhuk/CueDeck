/** Experimental single-owner scheduler. No Electron or production wiring. */
export interface SlideFrameKey {
  document: string
  page: number
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
  /** Absent for a static slide; future animation samples use integer microseconds. */
  timeUs?: number
}
export type FramePriority = 'program' | 'preview' | 'prefetch'
export interface OwnedSlideFrame {
  readonly byteLength: number
  close(): void
}
export interface SlideFrameBackend<T extends OwnedSlideFrame> {
  render(key: SlideFrameKey, signal: AbortSignal): Promise<T>
  dispose(): Promise<void>
}
export interface SlideFrameLease<T> {
  readonly frame: T
  release(): void
}
interface Waiter<T> {
  consumer: string
  priority: FramePriority
  resolve(value: SlideFrameLease<T> | null): void
  reject(error: unknown): void
}
interface Job<T> {
  id: string
  key: SlideFrameKey
  waiters: Map<string, Waiter<T>>
  controller: AbortController
}
interface Entry<T> { frame: T; refs: number; document: string; retired: boolean }
const priorities: Record<FramePriority, number> = { program: 0, preview: 1, prefetch: 2 }

/** The host may release speculative cache pins and retry without losing pixels
 * already copied to a receiver. An active borrowed frame must never be closed. */
export class FrameCachePressureError extends Error {
  constructor() { super('Byte budget pinned by slow consumers'); this.name = 'FrameCachePressureError' }
}

export class SlideFrameSource<T extends OwnedSlideFrame> {
  private cache = new Map<string, Entry<T>>()
  private retired = new Set<Entry<T>>()
  private jobs = new Map<string, Job<T>>()
  private pending = new Map<string, Job<T>>()
  private held = new Set<string>()
  private active: Job<T> | null = null
  private stopped = false
  private stopPromise: Promise<void> | null = null
  private drain: Promise<void> = Promise.resolve()
  private bytes = 0
  readonly stats = { rendered: 0, hits: 0, cancelled: 0, evicted: 0, peakBytes: 0 }

  constructor(private backend: SlideFrameBackend<T>, private budget = 128 * 1024 * 1024,
    private maxConsumers = 16) {
    if (!Number.isSafeInteger(budget) || budget < 4 || !Number.isSafeInteger(maxConsumers) || maxConsumers < 1) {
      throw new Error('Invalid frame source limits')
    }
  }

  get residentBytes(): number { return this.bytes }

  /** One outstanding lease per consumer. Copy/draw and acknowledge before requesting again. */
  request(consumer: string, key: SlideFrameKey, priority: FramePriority): Promise<SlideFrameLease<T> | null> {
    if (this.stopped) return Promise.resolve(null)
    if (!consumer || !key.document || !Number.isInteger(key.page) || key.page < 1 ||
      ![key.width, key.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192) ||
      ![0, 90, 180, 270].includes(key.rotation) ||
      (key.timeUs !== undefined && (!Number.isSafeInteger(key.timeUs) || key.timeUs < 0)) ||
      !Object.hasOwn(priorities, priority)) {
      return Promise.reject(new Error('Invalid slide frame request'))
    }
    if (key.width * key.height * 4 > this.budget) return Promise.reject(new Error('Frame exceeds byte budget'))
    if (this.held.has(consumer)) return Promise.reject(new Error('Consumer must release its previous frame'))
    if (!this.pending.has(consumer) && this.pending.size + this.held.size >= this.maxConsumers) {
      return Promise.reject(new Error('Consumer limit reached'))
    }
    // Cancel only this consumer; other users of the same render remain attached.
    this.cancel(consumer)
    const id = JSON.stringify([key.document, key.page, key.width, key.height, key.rotation, key.timeUs ?? null])
    const entry = this.cache.get(id)
    if (entry) {
      this.stats.hits++
      this.cache.delete(id)
      this.cache.set(id, entry)
      return Promise.resolve(this.lease(consumer, entry))
    }
    let job = this.jobs.get(id)
    if (!job) {
      job = { id, key: { ...key }, waiters: new Map(), controller: new AbortController() }
      this.jobs.set(id, job)
    }
    const target = job
    const promise = new Promise<SlideFrameLease<T> | null>((resolve, reject) => {
      target.waiters.set(consumer, { consumer, priority, resolve, reject })
      this.pending.set(consumer, target)
    })
    // Coalesce synchronous requests before choosing the next priority.
    queueMicrotask(() => this.pump())
    return promise
  }

  cancel(consumer: string): void {
    const job = this.pending.get(consumer)
    if (!job) return
    this.pending.delete(consumer)
    job.waiters.get(consumer)?.resolve(null)
    job.waiters.delete(consumer)
    if (!job.waiters.size) {
      this.jobs.delete(job.id)
      job.controller.abort()
      this.stats.cancelled++
    }
  }

  /** Remove one document without discarding another deck's warmed frames. */
  invalidateDocument(document: string): void {
    for (const [consumer, job] of [...this.pending]) if (job.key.document === document) this.cancel(consumer)
    for (const [id, entry] of [...this.cache]) if (entry.document === document) {
      entry.retired = true
      if (entry.refs) { this.cache.delete(id); this.retired.add(entry) }
      else this.removeEntry(entry)
    }
  }

  private lease(consumer: string, entry: Entry<T>): SlideFrameLease<T> {
    entry.refs++
    this.held.add(consumer)
    let released = false
    return { frame: entry.frame, release: () => {
      if (released) return
      released = true
      entry.refs--
      this.held.delete(consumer)
      // stop() retires cache entries only after their final reader acknowledges.
      if ((this.stopped || entry.retired) && !entry.refs) this.removeEntry(entry)
    } }
  }

  private removeEntry(entry: Entry<T>): void {
    if (this.retired.delete(entry)) {
      this.bytes -= entry.frame.byteLength
      entry.frame.close()
      return
    }
    for (const [id, candidate] of this.cache) if (candidate === entry) {
      this.cache.delete(id)
      this.bytes -= entry.frame.byteLength
      entry.frame.close()
      break
    }
  }

  private reserve(bytes: number): void {
    for (const entry of this.cache.values()) {
      if (this.bytes + bytes <= this.budget) break
      if (!entry.refs) { this.removeEntry(entry); this.stats.evicted++ }
    }
    if (this.bytes + bytes > this.budget) throw new FrameCachePressureError()
  }

  private pump(): void {
    if (this.stopped || this.active) return
    const rank = (job: Job<T>): number => Math.min(...[...job.waiters.values()].map(w => priorities[w.priority]))
    const job = [...this.jobs.values()].sort((a, b) => rank(a) - rank(b))[0]
    if (!job) return
    this.active = job
    this.drain = this.run(job).finally(() => { this.active = null; this.pump() })
  }

  private async run(job: Job<T>): Promise<void> {
    let frame: T | null = null
    try {
      const expectedBytes = job.key.width * job.key.height * 4
      this.reserve(expectedBytes)
      this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes + expectedBytes)
      frame = await this.backend.render(job.key, job.controller.signal)
      if (frame.byteLength !== expectedBytes) throw new Error('Backend returned unexpected frame size')
      if (this.stopped || job.controller.signal.aborted) return
      const entry: Entry<T> = { frame, refs: 0, document: job.key.document, retired: false }
      this.cache.set(job.id, entry)
      this.bytes += frame.byteLength
      frame = null
      this.stats.rendered++
      for (const waiter of job.waiters.values()) {
        this.pending.delete(waiter.consumer)
        waiter.resolve(this.lease(waiter.consumer, entry))
      }
    } catch (error) {
      for (const waiter of job.waiters.values()) {
        this.pending.delete(waiter.consumer)
        waiter.reject(error)
      }
    } finally {
      frame?.close()
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id)
    }
  }

  /** Late backend results are closed; held frames live until their owner releases. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    for (const consumer of [...this.pending.keys()]) this.cancel(consumer)
    for (const entry of this.cache.values()) if (!entry.refs) this.removeEntry(entry)
    this.stopPromise = this.drain.finally(() => this.backend.dispose())
    return this.stopPromise
  }
}
