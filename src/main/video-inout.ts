import type { AppState, FrameStepIdentity, FrameStepResult, FrameTimecode, VideoDeck, VideoRange, VideoRangeEdge, VideoRangeUpdateResult, VideoState } from '../shared/types.js'
import type { FrameTimeline, FrameTimelineProbeResult, FrameWindow } from '../shared/frame-timeline.js'
import { FRAME_WINDOW_BUCKET_SEC, FRAME_WINDOW_PAD_SEC, stepFrameTarget } from '../shared/frame-timeline.js'
import { formatFrameTimecode, frameTimecodeAt, totalFrameTimecodeAt } from '../shared/frame-timecode.js'
import {
  clampVideoPosition,
  entryVideoRange,
  normalizeVideoRange,
  RANGE_EPSILON,
} from '../shared/video-range.js'

/** Narrow store surface so the controller is testable without Electron. */
export interface VideoInOutStore {
  get(): AppState
  patch(partial: Partial<AppState>): void
  patchVideo(video: Partial<VideoState>): void
  patchPreviewVideo(video: Partial<VideoState>): void
  videoPositionSec(): number
  previewVideoPositionSec(): number
}

export interface FrameTimelineProvider {
  get(path: string, positionSec?: number, durationSec?: number): Promise<FrameTimelineProbeResult>
  getWindow?(path: string, window: FrameWindow): Promise<FrameTimelineProbeResult>
}

function deckView(state: AppState, deck: VideoDeck): { path: string | null; kind: AppState['fileKind']; video: VideoState } {
  return deck === 'preview'
    ? { path: state.preview.path, kind: state.preview.kind, video: state.preview.video }
    : { path: state.pdfPath, kind: state.fileKind, video: state.video }
}

function identityOf(state: AppState, deck: VideoDeck): FrameStepIdentity {
  return deck === 'preview'
    ? { entryId: state.preview.playlistId, path: state.preview.path, sha1: state.preview.sha1 }
    : { entryId: state.currentPlaylistId, path: state.pdfPath, sha1: state.pdfSha1 }
}

function sameIdentity(a: FrameStepIdentity, b: FrameStepIdentity): boolean {
  return a.entryId === b.entryId && a.path === b.path && a.sha1 === b.sha1
}

/** Exact paused-clock state; any seek/resume/range edit changes this key. */
function clockKey(v: VideoState): string {
  return [
    v.seekSeq ?? 0,
    v.anchorSec,
    v.anchorAt ?? 'null',
    v.playing ? 1 : 0,
    v.range?.inSec ?? 'null',
    v.range?.outSec ?? 'null',
  ].join('|')
}

function rawPosition(v: VideoState, now: number): number {
  const raw = v.playing && v.anchorAt != null ? v.anchorSec + (now - v.anchorAt) / 1000 : v.anchorSec
  return clampVideoPosition(raw, v.range, v.durationSec)
}

/**
 * Patch that applies a new range to one deck. Inside keeps the clock untouched
 * (position, playing, muted all preserved). Before In moves to In and keeps the
 * play state. At/after Out pauses on Out, or wraps to In for a looping entry.
 * Reset only clears the range — it never jumps or restarts.
 */
export function rangeApplicationPatch(
  v: VideoState,
  next: VideoRange | null,
  loop: boolean,
  now: number,
): Partial<VideoState> | null {
  if (!next) return { range: null }
  const bounds = normalizeVideoRange(next, v.durationSec)
  if (!bounds) return { range: null }
  const pos = rawPosition(v, now)
  if (pos < bounds.inSec - RANGE_EPSILON) {
    return {
      range: bounds,
      anchorSec: bounds.inSec,
      anchorAt: v.playing ? now : null,
    }
  }
  if (pos >= bounds.outSec - RANGE_EPSILON) {
    if (loop) {
      return {
        range: bounds,
        anchorSec: bounds.inSec,
        anchorAt: v.playing ? now : null,
      }
    }
    return { range: bounds, playing: false, anchorSec: bounds.outSec, anchorAt: null }
  }
  return { range: bounds }
}

/**
 * Main-process In/Out + frame-step controller. Range playback itself never
 * calls ffprobe; only frame stepping needs the external timestamp map.
 */
export class VideoInOutController {
  private readonly stepQueues = new Map<VideoDeck, Promise<unknown>>()
  /** Bumped when a step detects newer user intent; invalidates older queued arrows. */
  private readonly staleVersions = new Map<VideoDeck, number>()

  constructor(
    private readonly store: VideoInOutStore,
    private readonly frames: FrameTimelineProvider,
    private readonly persist: () => void,
  ) {}

  /** Serialised per deck: a second arrow press steps from the first result. */
  stepFrame(deck: VideoDeck, direction: number, expected?: FrameStepIdentity): Promise<FrameStepResult> {
    const queued = this.stepQueues.has(deck)
    const identity = expected ?? identityOf(this.store.get(), deck)
    const staleVersion = this.staleVersions.get(deck) ?? 0
    const previous = this.stepQueues.get(deck) ?? Promise.resolve()
    let run: Promise<FrameStepResult>
    run = previous.catch(() => undefined)
      .then(() => this.stepNow(deck, direction, identity, queued, staleVersion))
      .catch(() => ({ ok: false, reason: 'failed' } as FrameStepResult))
    this.stepQueues.set(deck, run)
    void run.then(() => {
      if (this.stepQueues.get(deck) === run) this.stepQueues.delete(deck)
    }, () => {
      if (this.stepQueues.get(deck) === run) this.stepQueues.delete(deck)
    })
    return run
  }

  private stale(deck: VideoDeck): FrameStepResult {
    this.staleVersions.set(deck, (this.staleVersions.get(deck) ?? 0) + 1)
    return { ok: false, reason: 'stale' }
  }

  private async stepNow(
    deck: VideoDeck,
    direction: number,
    expected: FrameStepIdentity,
    queued: boolean,
    staleVersion: number,
  ): Promise<FrameStepResult> {
    if ((this.staleVersions.get(deck) ?? 0) !== staleVersion) return { ok: false, reason: 'stale' }
    const state = this.store.get()
    if (!sameIdentity(identityOf(state, deck), expected)) return this.stale(deck)
    const initial = deckView(state, deck)
    if (initial.kind !== 'video' || !initial.path) return { ok: false, reason: 'not-video' }

    // A queued arrow arrives after a previous step already paused this deck.
    // If playback is running again, the operator resumed: drop the stale arrow
    // instead of pausing the new intent.
    if (queued && initial.video.playing) return this.stale(deck)

    const startPos = deck === 'preview' ? this.store.previewVideoPositionSec() : this.store.videoPositionSec()
    if (initial.video.playing) {
      const pause = { playing: false, anchorSec: startPos, anchorAt: null }
      if (deck === 'preview') this.store.patchPreviewVideo(pause)
      else this.store.patchVideo(pause)
    }
    // Capture AFTER our own pause. Later differences mean a user seek/resume/
    // range edit, not our step machinery.
    const pausedView = deckView(this.store.get(), deck)
    const pausedClock = clockKey(pausedView.video)

    let probe: FrameTimelineProbeResult
    try {
      probe = await this.frames.get(expected.path ?? initial.path, startPos, initial.video.durationSec)
    } catch {
      return { ok: false, reason: 'failed' }
    }
    if (!probe.ok) return { ok: false, reason: probe.reason }

    // Same entry/path/sha and the exact paused clock are required after ffprobe.
    // This rejects duplicate-entry switches on the same file and slow probes
    // overtaken by a user seek, resume or In/Out edit.
    const validatePaused = (): { view: ReturnType<typeof deckView>; state: AppState } | null => {
      const state = this.store.get()
      if (!sameIdentity(identityOf(state, deck), expected)) return null
      const view = deckView(state, deck)
      if (view.kind !== 'video' || view.path !== expected.path) return null
      if (view.video.playing || clockKey(view.video) !== pausedClock) return null
      return { view, state }
    }
    let valid = validatePaused()
    if (!valid) return this.stale(deck)
    const after = valid.view
    let from = deck === 'preview' ? this.store.previewVideoPositionSec() : this.store.videoPositionSec()
    let target = stepFrameTarget(probe.timeline.timestamps, from, direction)

    // A window can end just before the neighbour frame. Fetch an explicit
    // neighbour window before calling it an edge; only real file ends are edges.
    if (target == null) {
      const duration = after.video.durationSec
      const atStart = direction < 0 && from <= RANGE_EPSILON
      const atEnd = direction > 0 && duration > 0 && from >= duration - 0.05
      if (!atStart && !atEnd) {
        const fallback: FrameWindow = direction > 0
          ? { startSec: from, endSec: from + FRAME_WINDOW_BUCKET_SEC + FRAME_WINDOW_PAD_SEC }
          : {
              startSec: Math.max(0, from - FRAME_WINDOW_BUCKET_SEC - FRAME_WINDOW_PAD_SEC),
              endSec: from + 0.5,
            }
        let neighbour: FrameTimelineProbeResult
        try {
          neighbour = this.frames.getWindow
            ? await this.frames.getWindow(expected.path ?? initial.path, fallback)
            : await this.frames.get(expected.path ?? initial.path, from + (direction > 0 ? FRAME_WINDOW_BUCKET_SEC : -FRAME_WINDOW_BUCKET_SEC), duration)
        } catch {
          return { ok: false, reason: 'failed' }
        }
        if (!neighbour.ok) return { ok: false, reason: neighbour.reason }
        valid = validatePaused()
        if (!valid) return this.stale(deck)
        from = deck === 'preview' ? this.store.previewVideoPositionSec() : this.store.videoPositionSec()
        const merged = [...probe.timeline.timestamps, ...neighbour.timeline.timestamps]
          .sort((a, b) => a - b)
          .filter((value, index, all) => index === 0 || value - all[index - 1] > 1e-6)
        target = stepFrameTarget(merged, from, direction)
        if (target == null) return { ok: false, reason: atStart || atEnd ? 'edge' : 'no-frame' }
      } else {
        return { ok: false, reason: 'edge' }
      }
    }

    const sourceDuration = valid.view.video.durationSec
    // Decoded PTS can run past Chromium's media duration (edit lists/rounding).
    // Never store an anchor beyond the element's actual duration.
    if (sourceDuration > 0 && (target < -RANGE_EPSILON || target > sourceDuration + RANGE_EPSILON)) {
      return { ok: false, reason: 'edge' }
    }
    const bounds = normalizeVideoRange(valid.view.video.range, sourceDuration)
    if (bounds && (target < bounds.inSec - RANGE_EPSILON || target > bounds.outSec + RANGE_EPSILON)) {
      return { ok: false, reason: 'edge' }
    }
    const patch = { playing: false, anchorSec: target, anchorAt: null }
    if (deck === 'preview') this.store.patchPreviewVideo(patch)
    else this.store.patchVideo(patch)
    return { ok: true, position: target }
  }

  /**
   * Labels for the operator transport. Uses the same bounded decoded-frame
   * cache as stepping; no full-file scan. The identity is returned so a stale
   * async response cannot paint a new deck/card.
   */
  async timecode(deck: VideoDeck): Promise<FrameTimecode | null> {
    const state = this.store.get()
    const view = deckView(state, deck)
    if (view.kind !== 'video' || !view.path) return null
    const identity = identityOf(state, deck)
    const position = deck === 'preview' ? this.store.previewVideoPositionSec() : this.store.videoPositionSec()
    const duration = view.video.durationSec
    const range = normalizeVideoRange(view.video.range, duration)
    const wanted = [position]
    if (duration > 0) wanted.push(duration)
    if (range) wanted.push(range.inSec, range.outSec)
    const unique = [...new Set(wanted.filter((value) => Number.isFinite(value)))]
    const windows = await Promise.all(unique.map(async (sec) => {
      try {
        const result = await this.frames.get(view.path!, sec, duration)
        return result.ok ? result.timeline : null
      } catch {
        return null
      }
    }))
    const after = this.store.get()
    if (!sameIdentity(identityOf(after, deck), identity)) return null
    const timelines = new Map<number, FrameTimeline | null>()
    unique.forEach((sec, index) => timelines.set(sec, windows[index]))
    const currentTimeline = timelines.get(position) ?? null
    const totalTimeline = duration > 0 ? timelines.get(duration) ?? null : null
    const total = duration > 0
      ? (totalTimeline ? totalFrameTimecodeAt(totalTimeline, duration) ?? formatFrameTimecode(duration, null) : formatFrameTimecode(duration, null))
      : formatFrameTimecode(Number.NaN, null)
    return {
      current: currentTimeline ? frameTimecodeAt(currentTimeline, position) : formatFrameTimecode(position, null),
      total,
      in: range
        ? (timelines.get(range.inSec) ? frameTimecodeAt(timelines.get(range.inSec)!, range.inSec) : formatFrameTimecode(range.inSec, null))
        : null,
      out: range
        ? (timelines.get(range.outSec) ? frameTimecodeAt(timelines.get(range.outSec)!, range.outSec) : formatFrameTimecode(range.outSec, null))
        : null,
      identity,
    }
  }

  setRange(deck: VideoDeck, edge: VideoRangeEdge, now = Date.now()): VideoRangeUpdateResult {
    const state = this.store.get()
    const view = deckView(state, deck)
    if (view.kind !== 'video') return { ok: false, code: 'not-video' }
    const entryId = deck === 'preview' ? state.preview.playlistId : state.currentPlaylistId
    const entry = entryId ? state.playlist.find((e) => e.id === entryId) : undefined
    if (entry?.kind === 'list') return { ok: false, code: 'list-unsupported' }
    if (!entry || entry.kind !== 'video') return { ok: false, code: 'no-entry' }

    const duration = view.video.durationSec
    if (edge !== 'reset' && !(duration > 0)) return { ok: false, code: 'no-duration' }
    // Use the same `now` for the playhead and for the applied patch, so an
    // immediate edit is one atomic decision (and tests stay deterministic).
    const playhead = rawPosition(view.video, now)
    const current = entryVideoRange(entry, duration) ??
      (duration > 0 ? { inSec: 0, outSec: duration } : null)

    let next: VideoRange | null = null
    if (edge === 'in') {
      const outSec = current?.outSec ?? duration
      if (playhead >= outSec - RANGE_EPSILON) return { ok: false, code: 'invalid-range' }
      next = normalizeVideoRange({ inSec: playhead, outSec }, duration)
    } else if (edge === 'out') {
      const inSec = current?.inSec ?? 0
      if (playhead <= inSec + RANGE_EPSILON) return { ok: false, code: 'invalid-range' }
      next = normalizeVideoRange({ inSec, outSec: playhead }, duration)
    }

    const updated = { ...entry }
    if (next) {
      updated.inSec = next.inSec
      updated.outSec = next.outSec
    } else {
      delete updated.inSec
      delete updated.outSec
    }
    this.store.patch({ playlist: state.playlist.map((e) => (e.id === entry.id ? updated : e)) })
    this.persist()

    // Immediate policy: apply to every deck showing THIS entry id. Duplicate
    // entries for the same file have different ids and stay independent.
    const program = state
    if (program.currentPlaylistId === entry.id && program.fileKind === 'video') {
      const patch = rangeApplicationPatch(program.video, next, state.videoLoop, now)
      if (patch) this.store.patchVideo(patch)
    }
    const preview = state.preview
    if (preview.playlistId === entry.id && preview.kind === 'video') {
      const patch = rangeApplicationPatch(preview.video, next, Boolean(entry.loop), now)
      if (patch) this.store.patchPreviewVideo(patch)
    }

    return { ok: true, range: next, applied: 'immediate' }
  }
}
