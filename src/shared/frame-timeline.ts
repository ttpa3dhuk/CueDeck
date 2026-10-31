import type { FrameStepReason } from './types.js'

/**
 * Decoded video frame presentation timestamps, in seconds, ascending. No fixed
 * FPS is assumed; packet PTS is intentionally not used for exact stepping.
 *
 * These stay in ffprobe's raw media timeline. Do NOT subtract format/stream
 * start_time: a detached Chromium probe of a synthetic `-output_ts_offset 5`
 * MP4 reported HTML duration 6.75 and currentTime 5, so raw PTS 5..6.x already
 * matched the element timeline. Edit-list cases remain a known uncertainty and
 * must fail safely rather than be heuristically shifted.
 */
export interface FrameTimeline {
  timestamps: number[]
  /** Absolute media-coordinate window requested from ffprobe; absent = full scan. */
  window?: FrameWindow
}

export interface FrameWindow {
  startSec: number
  endSec: number
}

/** Window size/padding for long videos; one frame step never needs the whole file. */
export const FRAME_WINDOW_BUCKET_SEC = 5
export const FRAME_WINDOW_PAD_SEC = 2

/** Absolute media-coordinate window around a position, clipped to duration. */
export function frameWindowForPosition(
  positionSec: number,
  durationSec = 0,
): FrameWindow {
  const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0
  const bucket = Math.floor(position / FRAME_WINDOW_BUCKET_SEC) * FRAME_WINDOW_BUCKET_SEC
  let endSec = bucket + FRAME_WINDOW_BUCKET_SEC + FRAME_WINDOW_PAD_SEC
  if (Number.isFinite(durationSec) && durationSec > 0) endSec = Math.min(endSec, durationSec)
  let startSec = Math.max(0, bucket - FRAME_WINDOW_PAD_SEC)
  if (endSec <= startSec) {
    startSec = Math.max(0, endSec - FRAME_WINDOW_BUCKET_SEC)
  }
  return { startSec, endSec }
}

export type FrameTimelineProbeReason = Extract<
  FrameStepReason,
  'unavailable' | 'timeout' | 'cancelled' | 'too-large' | 'no-video' | 'failed'
>

export interface FrameTimelineProbeOk {
  ok: true
  timeline: FrameTimeline
}

export interface FrameTimelineProbeFailure {
  ok: false
  reason: FrameTimelineProbeReason
  message?: string
}

export type FrameTimelineProbeResult = FrameTimelineProbeOk | FrameTimelineProbeFailure

const FRAME_EPSILON = 1e-6

/**
 * ffprobe CSV (`-of csv=p=0`) has one value per line. Some builds prefix the
 * value (`best_effort_timestamp_time=…`), so accept both forms. N/A, negatives
 * and non-finite rows are ignored; duplicates and decode-order B-frames are
 * normalised by sorting. No assumed frame rate is involved.
 */
export function parseFrameTimestamps(output: string): number[] {
  const values: number[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const token = (line.includes('=') ? line.slice(line.lastIndexOf('=') + 1) : line.split(',')[0])
      .replace(/,$/, '')
      .trim()
    const value = Number(token)
    if (!Number.isFinite(value) || value < 0) continue
    values.push(value)
  }
  values.sort((a, b) => a - b)
  const unique: number[] = []
  for (const value of values) {
    if (unique.length === 0 || value - unique[unique.length - 1] > FRAME_EPSILON) unique.push(value)
  }
  return unique
}

/** Index of the frame whose presentation time is at or before `currentSec`. */
export function frameIndexAt(timestamps: number[], currentSec: number): number {
  if (timestamps.length === 0 || !Number.isFinite(currentSec)) return -1
  let lo = 0
  let hi = timestamps.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timestamps[mid] <= currentSec + FRAME_EPSILON) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * One actual frame forward/backward. Returns null at the first/last frame so
 * callers never wrap or invent a fixed 1/25 step on variable-frame-rate media.
 */
export function stepFrameTarget(
  timestamps: number[],
  currentSec: number,
  direction: number,
): number | null {
  if (timestamps.length === 0 || !Number.isFinite(currentSec)) return null
  const index = frameIndexAt(timestamps, currentSec)
  if (direction < 0) {
    // Between frames the containing frame is currently shown, so backward is
    // the frame before it — not the containing frame itself.
    return index <= 0 ? null : timestamps[index - 1]
  }
  if (index < 0) return timestamps[0]
  return index + 1 < timestamps.length ? timestamps[index + 1] : null
}
