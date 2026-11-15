import type { FramePriority, OwnedSlideFrame, SlideFrameKey, SlideFrameSource } from './frame-source.js'
import { FrameCachePressureError } from './frame-source.js'
import type { RenderDocumentInfo } from './kernel.js'

/** Structural port API: DOM MessagePort or an adapter around another process link. */
export interface FramePort {
  onmessage: ((event: { data: unknown }) => void) | null
  onmessageerror: (() => void) | null
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  start(): void
  close(): void
}
export interface FrameRequest { seq: number; generation: number; key: SlideFrameKey; priority: FramePriority; deliver?: boolean; retain?: boolean }
export type ClientFrameMessage =
  | ({ type: 'request' } & FrameRequest)
  | { type: 'cancel'; seq: number }
  | { type: 'ack'; delivery: number; generation: number; buffer: ArrayBuffer }
  | { type: 'close' }
export type OwnerFrameMessage =
  | { type: 'closed'; message: string }
  | { type: 'reset'; generation: number; documents: RenderDocumentInfo[] }
  | { type: 'frame'; generation: number; delivery: number; seq: number; key: SlideFrameKey; buffer: ArrayBuffer }
  | { type: 'error'; seq: number; message: string }
  | { type: 'prepared'; seq: number; generation: number }
interface Connection {
  id: string
  port: FramePort
  wanted: FrameRequest | null
  serial: number
  flight: { delivery: number; generation: number; bytes: number } | null
  rendering: boolean
  timer: ReturnType<typeof setTimeout> | null
  closed: boolean
  retained: { seq: number; document: string; release(): void } | null
}
type Source<T extends OwnedSlideFrame> = Pick<SlideFrameSource<T>, 'request' | 'cancel'>
const validSeq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0

/** CPU transport budget is separate from the raster cache. Each port has at most
 * one transferred buffer awaiting ACK; new requests replace its one wanted slot. */
export class FramePortServer<T extends OwnedSlideFrame> {
  private connections = new Map<string, Connection>()
  private source: Source<T> | null = null
  private documents: RenderDocumentInfo[] = []
  private generation = 0
  private delivery = 0
  private bytes = 0
  readonly stats = { delivered: 0, acknowledged: 0, prepared: 0, stale: 0, disconnected: 0, peakBytes: 0, pressureReclaims: 0 }
  constructor(private pack: (frame: T, key: SlideFrameKey) => ArrayBuffer,
    private budget = 128 * 1024 * 1024, private ackTimeoutMs = 15000, private maxPorts = 16) {
    if (!Number.isSafeInteger(budget) || budget < 4 || !Number.isFinite(ackTimeoutMs) || ackTimeoutMs < 1 ||
      !Number.isInteger(maxPorts) || maxPorts < 1) throw new Error('Invalid frame transport limits')
  }
  get inFlightBytes(): number { return this.bytes }

  attach(id: string, port: FramePort): void {
    if (!id || this.connections.has(id) || this.connections.size >= this.maxPorts) throw new Error('Invalid or duplicate frame port')
    const c: Connection = { id, port, wanted: null, serial: 0, flight: null, rendering: false, timer: null, closed: false, retained: null }
    this.connections.set(id, c)
    port.onmessage = event => this.receive(c, event.data)
    port.onmessageerror = () => this.detach(id)
    port.start()
    this.send(c, { type: 'reset', generation: this.generation, documents: this.documents })
  }

  /** Pause before stopping/replacing the old backend. Old transferred copies can
   * still be ACKed, but cannot paint after the receiver observes this generation. */
  pause(): number {
    this.generation++
    this.source = null
    this.documents = []
    for (const c of this.connections.values()) {
      c.serial++; c.wanted = null
      c.retained?.release(); c.retained = null
      this.send(c, { type: 'reset', generation: this.generation, documents: [] })
    }
    return this.generation
  }
  resume(source: Source<T>, documents: RenderDocumentInfo[], generation: number): void {
    if (generation !== this.generation) throw new Error('Stale kernel generation')
    this.source = source
    this.documents = documents.map(doc => ({ ...doc }))
    for (const c of this.connections.values()) {
      if (c.retained && !this.documents.some(doc => doc.id === c.retained!.document)) {
        c.retained.release(); c.retained = null
      }
      this.send(c, { type: 'reset', generation, documents: this.documents })
      void this.pump(c)
    }
  }

  /** Metadata changed, but surviving documents/ports keep their generation. */
  updateDocuments(documents: RenderDocumentInfo[]): void {
    this.documents = documents.map(doc => ({ ...doc }))
    for (const c of this.connections.values()) {
      if (c.retained && !this.documents.some(doc => doc.id === c.retained!.document)) {
        c.retained.release(); c.retained = null
      }
      if (c.wanted && !this.documents.some(doc => doc.id === c.wanted!.key.document)) {
        this.source?.cancel(c.id)
        this.send(c, { type: 'error', seq: c.wanted.seq, message: 'PDF revision was retired' })
        c.wanted = null; c.serial++
      }
      this.send(c, { type: 'reset', generation: this.generation, documents: this.documents })
    }
  }

  detach(id: string): void {
    const c = this.connections.get(id)
    if (!c) return
    c.closed = true; c.serial++
    c.retained?.release(); c.retained = null
    try { c.port.postMessage({ type: 'closed', message: 'Frame receiver disconnected or timed out' }) } catch { /* dead peer */ }
    this.source?.cancel(id)
    this.connections.delete(id)
    if (c.timer) clearTimeout(c.timer)
    if (c.flight) this.bytes -= c.flight.bytes
    c.flight = null; c.wanted = null
    c.port.onmessage = null; c.port.onmessageerror = null; c.port.close()
    this.stats.disconnected++
    this.wake()
  }
  close(): void { for (const id of [...this.connections.keys()]) this.detach(id) }

  private send(c: Connection, message: OwnerFrameMessage, transfer?: ArrayBuffer[]): boolean {
    try { c.port.postMessage(message, transfer); return true }
    catch { this.detach(c.id); return false }
  }
  private receive(c: Connection, raw: unknown): void {
    if (c.closed || !raw || typeof raw !== 'object') return
    const message = raw as ClientFrameMessage
    if (message.type === 'close') { this.detach(c.id); return }
    if (message.type === 'ack') {
      const flight = c.flight
      if (!flight || message.delivery !== flight.delivery || message.generation !== flight.generation ||
        !(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength !== flight.bytes) {
        this.detach(c.id); return
      }
      this.bytes -= flight.bytes; c.flight = null
      if (c.timer) clearTimeout(c.timer)
      c.timer = null; this.stats.acknowledged++
      this.wake(); return
    }
    if (message.type === 'cancel' && validSeq(message.seq)) {
      if (c.wanted?.seq === message.seq) { c.wanted = null; c.serial++; this.source?.cancel(c.id) }
      if (c.retained?.seq === message.seq) { c.retained.release(); c.retained = null }
      return
    }
    if (message.type !== 'request' || !validSeq(message.seq) || message.generation !== this.generation) return
    if (!message.key || typeof message.key !== 'object' ||
      (message.deliver !== undefined && typeof message.deliver !== 'boolean') ||
      (message.retain !== undefined && typeof message.retain !== 'boolean') ||
      (message.deliver === false && message.priority !== 'prefetch') ||
      !this.documents.some(doc => doc.id === message.key.document && message.key.page <= doc.pages) ||
      ![message.key.width, message.key.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192) ||
      !['program', 'preview', 'prefetch'].includes(message.priority)) {
      this.send(c, { type: 'error', seq: message.seq, message: 'Invalid frame request' }); return
    }
    c.serial++; this.source?.cancel(c.id)
    c.retained?.release(); c.retained = null
    c.wanted = { ...message, key: { ...message.key } }
    void this.pump(c)
  }
  private wake(): void { for (const c of this.connections.values()) void this.pump(c) }
  private async pump(c: Connection): Promise<void> {
    const source = this.source
    const request = c.wanted
    if (c.closed || c.flight || c.rendering || !source || !request) return
    const expected = request.deliver === false ? 0 : request.key.width * request.key.height * 4
    if (expected > this.budget) {
      c.wanted = null
      this.send(c, { type: 'error', seq: request.seq, message: 'Frame exceeds delivery budget' }); return
    }
    if (this.bytes + expected > this.budget) return // other receivers must acknowledge first
    // Reserve before the await: simultaneous completed rasters cannot oversubscribe copies.
    this.bytes += expected
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes)
    const serial = c.serial
    c.rendering = true
    let transferred = false
    try {
      const lease = await source.request(c.id, request.key, request.priority)
      if (!lease) {
        // A stopped backend may keep returning null. Do not spin the same wanted
        // request forever and starve the event loop/client timeout.
        if (!c.closed && c.serial === serial && this.source === source) {
          c.wanted = null
          this.send(c, { type: 'error', seq: request.seq, message: 'Frame request cancelled by render owner' })
        }
        return
      }
      let retained = false
      try {
        if (c.closed || c.serial !== serial || this.source !== source || request.generation !== this.generation) {
          this.stats.stale++; return
        }
        if (request.deliver === false) {
          if (request.retain) { c.retained = { seq: request.seq, document: request.key.document, release: lease.release }; retained = true }
          c.wanted = null; this.stats.prepared++
          this.send(c, { type: 'prepared', seq: request.seq, generation: request.generation })
          return
        }
        const buffer = this.pack(lease.frame, request.key)
        if (buffer.byteLength !== expected) throw new Error('Invalid packed frame size')
        c.flight = { delivery: ++this.delivery, generation: request.generation, bytes: expected }
        if (request.retain) { c.retained = { seq: request.seq, document: request.key.document, release: lease.release }; retained = true }
        c.wanted = null
        transferred = true
        if (!this.send(c, { type: 'frame', seq: request.seq, generation: request.generation,
          delivery: c.flight.delivery, key: request.key, buffer }, [buffer])) return
        this.stats.delivered++
        c.timer = setTimeout(() => this.detach(c.id), this.ackTimeoutMs)
      } finally { if (!retained) lease.release() }
    } catch (error) {
      if (!c.closed && c.serial === serial) {
        if (error instanceof FrameCachePressureError && this.source === source) {
          // Next/preload leases are cache hints, not in-flight read ownership.
          // A lagging view may retain an older Next while faster views advance.
          // Release these hints under pressure, then pump the latest wanted key.
          let released = false
          for (const peer of this.connections.values()) if (peer.retained) {
            peer.retained.release(); peer.retained = null; released = true
          }
          if (released) { this.stats.pressureReclaims++; return }
        }
        c.wanted = null
        this.send(c, { type: 'error', seq: request.seq, message: error instanceof Error ? error.message : 'Render failed' })
      }
    } finally {
      c.rendering = false
      if (!transferred) this.bytes -= expected
      // A closed connection's transferred bytes were already released by detach.
      this.wake()
    }
  }
}

/** Receiver owns only display pixels; PDF.js and document buffers never arrive here. */
export class FramePortClient {
  private seq = 0
  private pending: { seq: number; resolve(value: boolean): void; reject(error: Error): void } | null = null
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  generation = 0
  documents: RenderDocumentInfo[] = []
  readonly stats = { painted: 0, stale: 0, resets: 0 }
  onreset: (() => void) | null = null
  constructor(private port: FramePort, private paint: (buffer: ArrayBuffer, key: SlideFrameKey) => void,
    private timeoutMs = 120000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Invalid render response timeout')
    port.onmessage = event => this.receive(event.data)
    port.onmessageerror = () => this.close()
    port.start()
  }
  request(key: SlideFrameKey, priority: FramePriority, deliver = true, retain = false): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    this.pending?.resolve(false)
    this.clearTimer()
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending = { seq, resolve, reject }
      this.timer = setTimeout(() => {
        this.pending = null; this.clearTimer()
        try { this.port.postMessage({ type: 'cancel', seq }) } catch { /* peer crashed */ }
        reject(new Error('Render owner did not respond before timeout'))
      }, this.timeoutMs)
      try { this.port.postMessage({ type: 'request', seq, generation: this.generation, key, priority, deliver, retain }) }
      catch (error) { this.pending = null; this.clearTimer(); reject(error) }
    })
  }
  cancel(): void {
    if (this.closed || !this.seq) return
    const pending = this.pending
    const seq = pending?.seq ?? this.seq
    this.pending = null
    this.clearTimer()
    try { this.port.postMessage({ type: 'cancel', seq }) } catch { /* disconnected */ }
    pending?.resolve(false)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearTimer()
    this.pending?.resolve(false); this.pending = null
    try { this.port.postMessage({ type: 'close' }) } catch { /* disconnected owner */ }
    this.port.onmessage = null; this.port.onmessageerror = null; this.port.close()
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
  private receive(raw: unknown): void {
    if (this.closed || !raw || typeof raw !== 'object') return
    const message = raw as OwnerFrameMessage
    if (message.type === 'closed') {
      this.pending?.reject(new Error(message.message)); this.pending = null
      this.close(); return
    }
    if (message.type === 'reset') {
      if (message.generation < this.generation) return
      if (message.generation !== this.generation) { this.pending?.resolve(false); this.pending = null; this.clearTimer() }
      this.generation = message.generation
      this.documents = message.documents
      this.stats.resets++; this.onreset?.(); return
    }
    const pending = this.pending
    if (message.type === 'prepared') {
      if (pending?.seq === message.seq && message.generation === this.generation) {
        this.pending = null; this.clearTimer(); pending.resolve(true)
      }
      return
    }
    if (message.type === 'error') {
      if (pending?.seq === message.seq) { this.pending = null; this.clearTimer(); pending.reject(new Error(message.message)) }
      return
    }
    if (message.type !== 'frame') return
    const current = pending?.seq === message.seq && message.generation === this.generation
    let error: Error | null = null
    let ackFailed = false
    try {
      if (current) { this.paint(message.buffer, message.key); this.stats.painted++ }
      else this.stats.stale++
    } catch (cause) { error = cause instanceof Error ? cause : new Error('Frame paint failed') }
    finally {
      // Return the transferred allocation. Receiver no longer owns a live copy.
      try {
        this.port.postMessage({ type: 'ack', delivery: message.delivery, generation: message.generation,
          buffer: message.buffer }, [message.buffer])
      } catch {
        error = new Error('Frame acknowledgement failed'); ackFailed = true
      }
    }
    if (current && pending) {
      this.pending = null
      this.clearTimer()
      if (error) pending.reject(error)
      else pending.resolve(true)
    }
    if (ackFailed) this.close()
  }
}
