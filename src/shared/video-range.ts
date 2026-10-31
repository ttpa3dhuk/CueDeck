import type { DeckState, FileKind, PlaylistEntry, VideoRange, VideoState, VideoTakeMode } from './types.js'

/** Two values closer than this are the same media instant. */
export const RANGE_EPSILON = 1e-6
/** A paused clock this close to In is still "at the first frame". */
export const RANGE_START_EPSILON = 0.05

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Clamp a stored range to a known media duration and reject unusable values.
 * A range covering the whole clip is represented as null, so old projects and
 * "Reset boundaries" share one code path.
 */
export function normalizeVideoRange(
  range: VideoRange | null | undefined,
  durationSec: number,
): VideoRange | null {
  if (!range || !finite(range.inSec) || !finite(range.outSec)) return null
  const duration = finite(durationSec) && durationSec > 0 ? durationSec : 0
  let inSec = Math.max(0, range.inSec)
  let outSec = range.outSec
  if (duration > 0) {
    inSec = Math.min(inSec, duration)
    outSec = Math.min(outSec, duration)
  }
  if (inSec < 0 || !finite(outSec) || outSec <= inSec + RANGE_EPSILON) return null
  if (duration > 0 && inSec <= RANGE_EPSILON && outSec >= duration - RANGE_EPSILON) return null
  return { inSec, outSec }
}

/** Validate values read from a project file before any duration is known. */
export function sanitizeStoredVideoRange(inSec: unknown, outSec: unknown): VideoRange | null {
  if (!finite(inSec) || !finite(outSec)) return null
  if (inSec < 0 || outSec <= inSec + RANGE_EPSILON) return null
  return { inSec, outSec }
}

/**
 * Bounds stored on a playlist entry. Both fields must be present; a half-written
 * pair is a corrupt legacy value, not "In only / Out only".
 */
export function entryVideoRange(entry: PlaylistEntry | undefined, durationSec: number): VideoRange | null {
  if (!entry || entry.kind !== 'video') return null
  const stored = sanitizeStoredVideoRange(entry.inSec, entry.outSec)
  return normalizeVideoRange(stored, durationSec)
}

/** Applied bounds of a deck's clock (not the pending playlist value). */
export function videoRangeOf(v: Pick<VideoState, 'range' | 'durationSec'>): VideoRange | null {
  return normalizeVideoRange(v.range, v.durationSec)
}

export function clampVideoPosition(
  sec: number,
  range: VideoRange | null | undefined,
  durationSec: number,
): number {
  let pos = finite(sec) ? sec : 0
  pos = Math.max(0, pos)
  if (finite(durationSec) && durationSec > 0) pos = Math.min(pos, durationSec)
  const bounds = normalizeVideoRange(range, durationSec)
  if (bounds) pos = Math.min(bounds.outSec, Math.max(bounds.inSec, pos))
  return pos
}

/** First position a bounded clip plays from. */
export function videoRangeStart(range: VideoRange | null | undefined, durationSec: number): number {
  return normalizeVideoRange(range, durationSec)?.inSec ?? 0
}

/** Last position a bounded clip plays to (duration when unbounded/unknown). */
export function videoRangeEnd(range: VideoRange | null | undefined, durationSec: number): number {
  const bounds = normalizeVideoRange(range, durationSec)
  if (bounds) return bounds.outSec
  return finite(durationSec) && durationSec > 0 ? durationSec : 0
}

/** Seek patch bounded by the applied range and paused when the target is Out. */
export function seekVideoTo(
  v: Pick<VideoState, 'playing' | 'range' | 'durationSec'>,
  sec: number,
  now = Date.now(),
): Partial<VideoState> {
  const bounds = normalizeVideoRange(v.range, v.durationSec)
  const target = clampVideoPosition(sec, bounds, v.durationSec)
  const atEnd = Boolean(bounds && target >= bounds.outSec - RANGE_EPSILON)
  const pauseAtEnd = atEnd && v.playing
  return {
    anchorSec: target,
    anchorAt: v.playing && !atEnd ? now : null,
    ...(pauseAtEnd ? { playing: false } : {}),
  }
}

/** Play/resume patch: a click at Out restarts from In instead of sticking there. */
export function playVideoFrom(
  v: Pick<VideoState, 'playing' | 'range' | 'durationSec'>,
  positionSec: number,
  now = Date.now(),
): Partial<VideoState> {
  if (v.playing) return {}
  const bounds = normalizeVideoRange(v.range, v.durationSec)
  let start = clampVideoPosition(positionSec, bounds, v.durationSec)
  if (bounds) {
    if (start >= bounds.outSec - RANGE_EPSILON) start = bounds.inSec
    else if (start < bounds.inSec) start = bounds.inSec
  }
  return { playing: true, anchorSec: start, anchorAt: now }
}

/** End-of-media patch: loop wraps to In, otherwise freeze on Out. */
export function endVideo(
  v: Pick<VideoState, 'anchorSec' | 'durationSec' | 'range'>,
  loop: boolean,
  now = Date.now(),
): Partial<VideoState> {
  const bounds = normalizeVideoRange(v.range, v.durationSec)
  const inSec = bounds?.inSec ?? 0
  const outSec = bounds?.outSec ?? (v.durationSec > 0 ? v.durationSec : v.anchorSec)
  if (loop) return { playing: true, anchorSec: inSec, anchorAt: now }
  return { playing: false, anchorSec: outSec, anchorAt: null }
}

/** Is the clock standing on the first frame of its range? */
export function isVideoAtStart(positionSec: number, range: VideoRange | null | undefined, durationSec: number): boolean {
  const bounds = normalizeVideoRange(range, durationSec)
  return bounds ? positionSec <= bounds.inSec + RANGE_START_EPSILON : positionSec < 0.5
}

export interface VideoTakePlanInput {
  mode: VideoTakeMode
  previewPositionSec: number
  durationSec: number
  range: VideoRange | null | undefined
  muted: boolean
  now?: number
}

/**
 * Build the program clock for a standalone video TAKE. `play-start` begins at
 * In, `play-resume` clamps the preview position to the range, `hold-first`
 * freezes on In. The range snapshot is part of the returned state, so later
 * playlist edits cannot change what is already on air.
 */
export function planVideoTake(input: VideoTakePlanInput): VideoState {
  const now = input.now ?? Date.now()
  const bounds = normalizeVideoRange(input.range, input.durationSec)
  const inSec = bounds?.inSec ?? 0
  const outSec = bounds?.outSec ?? (input.durationSec > 0 ? input.durationSec : 0)
  const base = {
    durationSec: input.durationSec,
    muted: input.muted,
    ...(bounds ? { range: bounds } : {}),
  }

  if (input.mode === 'hold-first') {
    return { ...base, playing: false, anchorSec: inSec, anchorAt: null }
  }

  if (input.mode === 'play-resume') {
    const pos = clampVideoPosition(input.previewPositionSec, bounds, input.durationSec)
    const atEnd = outSec > 0 && pos >= outSec - RANGE_EPSILON
    return { ...base, playing: !atEnd, anchorSec: atEnd ? outSec : pos, anchorAt: atEnd ? null : now }
  }

  return { ...base, playing: true, anchorSec: inSec, anchorAt: now }
}

export interface VideoRangeLayout {
  leftPct: number
  widthPct: number
  inPct: number
  outPct: number
}

/** Percentage geometry for the selected-range band and In/Out markers. */
export function videoRangeLayout(
  range: VideoRange | null | undefined,
  durationSec: number,
): VideoRangeLayout | null {
  const bounds = normalizeVideoRange(range, durationSec)
  if (!bounds || !(durationSec > 0)) return null
  const inPct = Math.max(0, Math.min(100, bounds.inSec / durationSec * 100))
  const outPct = Math.max(0, Math.min(100, bounds.outSec / durationSec * 100))
  return { leftPct: inPct, widthPct: Math.max(0, outPct - inPct), inPct, outPct }
}


/** Preserve the decoder's known duration when an activation reuses the same source. */
export function reusedVideoDuration(
  previous: Pick<DeckState, 'path' | 'sha1' | 'kind' | 'video'>,
  nextPath: string,
  nextSha1: string | null,
  nextKind: FileKind | null,
): number {
  if (nextKind !== 'video' || previous.kind !== 'video') return 0
  if (!previous.path || previous.path !== nextPath) return 0
  if (!previous.sha1 || previous.sha1 !== nextSha1) return 0
  return previous.video.durationSec > 0 ? previous.video.durationSec : 0
}
