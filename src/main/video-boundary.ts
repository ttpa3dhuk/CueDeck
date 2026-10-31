import type { AppState, VideoDeck, VideoState } from '../shared/types.js'
import { endVideo, normalizeVideoRange, RANGE_EPSILON } from '../shared/video-range.js'
import type { VideoInOutStore } from './video-inout.js'

export interface VideoBoundaryStore extends VideoInOutStore {
  onChange(listener: (state: AppState, patch: Partial<AppState>) => void): () => void
}

const MAX_TIMEOUT_MS = 2_147_000_000

/**
 * Main-process Out deadline. A 250 ms renderer tick is far too coarse for short
 * loops and lets audio run past Out; this timer is independent of the visible
 * window and of the native-vs-mirror playback path. The resulting state patch
 * reaches every window, including mirror consumers.
 */
export class VideoBoundaryScheduler {
  private timers: Record<VideoDeck, ReturnType<typeof setTimeout> | null> = { program: null, preview: null }
  private unsubscribe: (() => void) | null = null

  constructor(private readonly store: VideoBoundaryStore) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.onChange((_state, patch) => {
      if (patch.video || patch.preview) this.sync()
    })
    this.sync()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.clear('program')
    this.clear('preview')
  }

  /** Recompute both deadlines after a play/pause/seek/range change. */
  sync(): void {
    this.schedule('program')
    this.schedule('preview')
  }

  private clear(deck: VideoDeck): void {
    const timer = this.timers[deck]
    if (timer) clearTimeout(timer)
    this.timers[deck] = null
  }

  private videoOf(deck: VideoDeck): VideoState {
    return deck === 'preview' ? this.store.get().preview.video : this.store.get().video
  }

  private positionOf(deck: VideoDeck): number {
    return deck === 'preview' ? this.store.previewVideoPositionSec() : this.store.videoPositionSec()
  }

  private loopOf(deck: VideoDeck): boolean {
    if (deck === 'program') return this.store.get().videoLoop
    const state = this.store.get()
    const entry = state.preview.playlistId
      ? state.playlist.find((e) => e.id === state.preview.playlistId)
      : undefined
    return Boolean(entry?.loop)
  }

  private schedule(deck: VideoDeck): void {
    this.clear(deck)
    const v = this.videoOf(deck)
    if (!v.playing) return
    const bounds = normalizeVideoRange(v.range, v.durationSec)
    if (!bounds) return
    const remainingMs = Math.max(0, (bounds.outSec - this.positionOf(deck)) * 1000)
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, remainingMs))
    this.timers[deck] = setTimeout(() => this.fire(deck, bounds.outSec), delay)
  }

  private fire(deck: VideoDeck, expectedOutSec: number): void {
    this.timers[deck] = null
    const v = this.videoOf(deck)
    if (!v.playing) return
    const bounds = normalizeVideoRange(v.range, v.durationSec)
    if (!bounds || Math.abs(bounds.outSec - expectedOutSec) > RANGE_EPSILON) {
      // Range changed while the timer was running; the state patch rescheduled it.
      return
    }
    if (this.positionOf(deck) < bounds.outSec - RANGE_EPSILON) {
      // setTimeout fired a hair early; keep the remaining deadline.
      this.schedule(deck)
      return
    }
    const patch = endVideo(v, this.loopOf(deck))
    if (deck === 'program') this.store.patchVideo(patch)
    else this.store.patchPreviewVideo(patch)
  }
}
