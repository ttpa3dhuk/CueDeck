import type { NativeImage } from 'electron'
import type { AppState } from '../shared/types.js'

/** Network program only. The compositor and the physical audience are not delayed. */
export const PROGRAM_VIDEO_DELAY_MS = 80
export const PROGRAM_AUDIO_DELAY_MS = 120
const MAX_VIDEO_AGE_MS = 200
// Shared once, regardless of whether NDI and OMT are both enabled. Six 5K
// captures still cover the delayed clock at 60 Hz; never two copies per output.
const MAX_VIDEO_BYTES = 384 * 1024 * 1024
const MAX_VIDEO_FRAMES = 12

interface Frame { id: number; at: number; image: NativeImage; bytes: number }
export interface ProgramFrame { image: NativeImage; id: number; epoch: number; cut: boolean }

/** One capture timeline shared by the two network transports, with independent cursors. */
export class ProgramVideoTimeline {
  private frames: Frame[] = []
  private nextId = 0
  private generation = 0
  private bytes = 0
  private sourceInterval = 33
  private lastCaptureAt: number | null = null
  private memoryPressure = false
  private cutAt = -Infinity
  private cutId = 0

  get epoch(): number { return this.generation }
  /** Accepted unique compositor captures, shared across all network outputs. */
  get captureCount(): number { return this.nextId }

  reset(): void {
    this.generation++
    this.frames = []
    this.bytes = 0
    this.lastCaptureAt = null
    this.memoryPressure = false
    this.cutAt = -Infinity
    this.cutId = 0
  }

  markCut(at = performance.now()): void {
    if (at - this.cutAt < 5 && this.cutId === this.nextId) return
    this.cutAt = at
    this.cutId = this.nextId
  }

  cutIsDue(lastId: number, now: number): boolean {
    return Number.isFinite(this.cutAt) && lastId <= this.cutId && now >= this.cutAt + PROGRAM_VIDEO_DELAY_MS
  }

  hasFreshCut(lastId: number, now: number): boolean {
    return this.cutIsDue(lastId, now) && this.frames.some(frame =>
      frame.id > this.cutId && frame.at >= this.cutAt && frame.at <= now - PROGRAM_VIDEO_DELAY_MS)
  }

  push(image: NativeImage, at = performance.now()): void {
    if (image.isEmpty()) return
    const { width, height } = image.getSize()
    const bytes = width * height * 4
    if (bytes <= 0 || bytes > MAX_VIDEO_BYTES) return
    const frame = { id: ++this.nextId, at, image, bytes }
    if (this.lastCaptureAt !== null) {
      const interval = at - this.lastCaptureAt
      if (interval >= 8 && interval <= 100) this.sourceInterval = this.sourceInterval * 0.9 + interval * 0.1
    }
    this.lastCaptureAt = at
    this.frames.push(frame)
    this.bytes += bytes
    while (this.frames.length > MAX_VIDEO_FRAMES || this.bytes > MAX_VIDEO_BYTES ||
      (this.frames.length > 1 && at - this.frames[0].at > MAX_VIDEO_AGE_MS + PROGRAM_VIDEO_DELAY_MS)) {
      if (this.bytes > MAX_VIDEO_BYTES) this.memoryPressure = true
      this.bytes -= this.frames.shift()!.bytes
    }
  }

  consumer(): ProgramVideoCursor { return new ProgramVideoCursor(this) }

  select(afterId: number, now: number, fps: number, longIdle: boolean): Frame | null {
    const target = now - PROGRAM_VIDEO_DELAY_MS
    let eligible = -1
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i].at <= target) eligible = i
      else break
    }
    // An unusually large capture can exhaust the byte cap before the nominal
    // delay is covered. Keep advancing rather than freezing a stale picture.
    if (eligible < 0 && this.memoryPressure) eligible = this.frames.length - 1
    if (eligible < 0) return null
    const newest = this.frames[eligible]
    if (newest.id <= afterId) return null
    if (this.cutIsDue(afterId, now)) {
      const fresh = this.frames.slice(0, eligible + 1).filter(frame =>
        frame.id > this.cutId && frame.at >= this.cutAt)
      if (!fresh.length) return null
      // Keep the first still-live frame of the new segment. If it has gone
      // static, its sole final frame remains valid after the age budget.
      return fresh.find(frame => frame.at >= now - MAX_VIDEO_AGE_MS) ?? fresh[fresh.length - 1]
    }
    // In normal operation advance by at most two source frames per free slot.
    // A long native stall must not play a stale backlog after recovery.
    if (afterId) {
      const maxStep = Math.max(2, Math.min(6, Math.ceil((1000 / fps) / this.sourceInterval * 1.15)))
      for (let i = eligible; i >= 0; i--) {
        if (this.frames[i].id > afterId && this.frames[i].id <= afterId + maxStep &&
          this.frames[i].at >= now - MAX_VIDEO_AGE_MS) return this.frames[i]
      }
      if (longIdle) return newest
      // The bounded step has fallen behind live playback. Rejoin the oldest
      // still-live frame, without draining a stale queue after a native stall.
      for (let i = 0; i <= eligible; i++) {
        if (this.frames[i].id > afterId && this.frames[i].at >= now - MAX_VIDEO_AGE_MS) return this.frames[i]
      }
    }
    return newest
  }
}

export interface ProgramPcm {
  sampleRate: number
  channels: number
  frames: number
  data: Float32Array
}

interface TimedPcm { at: number; chunk: ProgramPcm }

/** PCM uses the same monotonic clock as video; no extra per-transport queue. */
export class ProgramAudioTimeline {
  private chunks: TimedPcm[] = []
  private nextAt: number | null = null
  private lastDispatchAt = -Infinity

  reset(): void { this.chunks = []; this.nextAt = null; this.lastDispatchAt = -Infinity }

  push(chunk: ProgramPcm, now = performance.now()): void {
    const duration = chunk.frames * 1000 / chunk.sampleRate
    const measured = now - duration
    // A short IPC burst is still contiguous audio; a capture restart is not.
    const at = this.nextAt !== null && Math.abs(this.nextAt - measured) <= 80 ? this.nextAt : measured
    this.nextAt = at + duration
    this.chunks.push({ at, chunk })
    while (this.chunks.length > 20 || (this.chunks.length > 1 && now - this.chunks[0].at > 500)) this.chunks.shift()
  }

  /** One contiguous planar packet (at most 80 ms) per dispatch; no catch-up burst. */
  due(now = performance.now()): ProgramPcm | null {
    const cutoff = now - PROGRAM_AUDIO_DELAY_MS
    // A true long stall cannot be replayed as a burst. Ordinary 40–80 ms IPC
    // accumulation remains intact and is sent as one contiguous packet.
    while (this.chunks.length > 1 && this.chunks[0].at < now - 400) this.chunks.shift()
    const due: ProgramPcm[] = []
    while (this.chunks.length && due.length < 4 && this.chunks[0].at <= cutoff) {
      due.push(this.chunks.shift()!.chunk)
    }
    if (!due.length) return null
    this.lastDispatchAt = now
    if (due.length === 1) return due[0]
    const frames = due.reduce((sum, chunk) => sum + chunk.frames, 0)
    const data = new Float32Array(frames * 2)
    for (let channel = 0; channel < 2; channel++) {
      let offset = channel * frames
      for (const chunk of due) {
        data.set(chunk.data.subarray(channel * chunk.frames, (channel + 1) * chunk.frames), offset)
        offset += chunk.frames
      }
    }
    return { sampleRate: 48000, channels: 2, frames, data }
  }

  nextDueAt(): number | null {
    return this.chunks.length ? Math.max(this.chunks[0].at + PROGRAM_AUDIO_DELAY_MS, this.lastDispatchAt + 20) : null
  }
}

export class ProgramVideoCursor {
  private seenEpoch = -1
  private lastId = 0
  private lastPollAt: number | null = null
  private lastCaptureCount: number
  constructor(private readonly timeline: ProgramVideoTimeline) {
    // A cached frame delivered on subscription is not a new source capture.
    this.lastCaptureCount = timeline.captureCount
  }

  /** Per-subscriber delta for the diagnostic window; selecting a frame is not a capture. */
  takeSourceCaptures(): number {
    const count = this.timeline.captureCount
    const delta = Math.max(0, count - this.lastCaptureCount)
    this.lastCaptureCount = count
    return delta
  }

  next(fps: number, now = performance.now()): ProgramFrame | null {
    const epoch = this.timeline.epoch
    if (this.seenEpoch !== epoch) { this.seenEpoch = epoch; this.lastId = 0; this.lastPollAt = null }
    const longIdle = this.lastPollAt !== null && now - this.lastPollAt > MAX_VIDEO_AGE_MS
    this.lastPollAt = now
    const cut = this.timeline.cutIsDue(this.lastId, now)
    const frame = this.timeline.select(this.lastId, now, fps, longIdle)
    if (!frame) return null
    this.lastId = frame.id
    return { image: frame.image, id: frame.id, epoch, cut }
  }

  get epoch(): number { return this.timeline.epoch }
  cutIsDue(now = performance.now()): boolean { return this.timeline.cutIsDue(this.lastId, now) }
  hasFreshCut(now = performance.now()): boolean { return this.timeline.hasFreshCut(this.lastId, now) }
  superseded(frameId: number, now = performance.now()): boolean {
    return this.timeline.hasFreshCut(frameId, now)
  }
}

export function isProgramTransition(patch: Partial<AppState>, before: AppState): boolean {
  return (Object.hasOwn(patch, 'pdfPath') && patch.pdfPath !== before.pdfPath) ||
    (Object.hasOwn(patch, 'pdfSha1') && patch.pdfSha1 !== before.pdfSha1) ||
    (Object.hasOwn(patch, 'currentSlide') && patch.currentSlide !== before.currentSlide) ||
    (Object.hasOwn(patch, 'blackout') && patch.blackout !== before.blackout) ||
    (patch.video !== undefined && patch.video.seekSeq !== before.video.seekSeq)
}
