import { frameIndexAt, type FrameTimeline } from './frame-timeline.js'

const EPSILON = 1e-6
const UNKNOWN = '--:--:--'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * MM:SS:FF. MM is total minutes (no drop-frame claim); FF is the index of the
 * decoded frame inside its own presentation second. A null frame index is an
 * explicit `--` suffix, never an invented count.
 */
export function formatFrameTimecode(seconds: number, frameIndex: number | null): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNKNOWN
  const total = Math.floor(seconds + EPSILON)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  const ff = frameIndex !== null && Number.isInteger(frameIndex) && frameIndex >= 0
    ? pad2(frameIndex)
    : '--'
  return `${pad2(mm)}:${pad2(ss)}:${ff}`
}

/**
 * The window must start at/before this second so all frames of that second
 * before the displayed one are counted. ffprobe may output earlier keyframes,
 * so the first actual timestamp also proves coverage.
 */
function secondCovered(timeline: FrameTimeline, secondStart: number): boolean {
  if (!timeline.window) return true
  // The requested window alone is not proof: a keyframe seek can return its
  // first PTS after earlier frames of that second. Only an actual first PTS at/
  // before the boundary, or a request from source origin 0, proves coverage.
  if (timeline.timestamps.length > 0 && timeline.timestamps[0] <= secondStart + EPSILON) return true
  return timeline.window.startSec <= EPSILON
}

function labelForFrame(timeline: FrameTimeline, framePts: number): string {
  const secondStart = Math.floor(framePts + EPSILON)
  if (!secondCovered(timeline, secondStart)) return formatFrameTimecode(framePts, null)
  let index = -1
  for (const t of timeline.timestamps) {
    if (t >= secondStart - EPSILON && t <= framePts + EPSILON) index++
    if (t > framePts + EPSILON) break
  }
  return formatFrameTimecode(framePts, index >= 0 ? index : null)
}

/** Displayed frame at or before a playhead position. */
export function frameTimecodeAt(timeline: FrameTimeline, positionSec: number): string {
  const index = frameIndexAt(timeline.timestamps, positionSec)
  if (index < 0) return formatFrameTimecode(positionSec, null)
  return labelForFrame(timeline, timeline.timestamps[index])
}

/** Only a decoded frame exactly on the boundary gives a known boundary label. */
export function exactFrameTimecodeAt(timeline: FrameTimeline, boundarySec: number): string | null {
  if (timeline.window && boundarySec > timeline.window.endSec + EPSILON) return null
  const index = frameIndexAt(timeline.timestamps, boundarySec)
  if (index < 0) return null
  const pts = timeline.timestamps[index]
  if (Math.abs(pts - boundarySec) > 1e-3) return null
  return labelForFrame(timeline, pts)
}

/**
 * Exclusive EOF total: boundary second + count of decoded frame starts in that
 * second strictly before the duration. No FPS extrapolation; unknown coverage
 * returns null. Ordinary 21.000 s CFR therefore ends at 00:21:00, not 00:21:--.
 */
export function totalFrameTimecodeAt(timeline: FrameTimeline, durationSec: number): string | null {
  if (!Number.isFinite(durationSec) || durationSec < 0) return null
  if (timeline.window && timeline.window.endSec < durationSec - EPSILON) return null
  const boundarySecond = Math.floor(durationSec + EPSILON)
  if (!secondCovered(timeline, boundarySecond)) return null
  let count = 0
  for (const t of timeline.timestamps) {
    if (t < boundarySecond) continue
    if (t >= durationSec) break
    count++
  }
  return formatFrameTimecode(durationSec, count)
}
