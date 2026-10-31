import { describe, expect, it } from 'vitest'
import type { PlaylistEntry, VideoRange, VideoState } from '../src/shared/types'
import {
  clampVideoPosition,
  endVideo,
  entryVideoRange,
  isVideoAtStart,
  normalizeVideoRange,
  planVideoTake,
  playVideoFrom,
  sanitizeStoredVideoRange,
  reusedVideoDuration,
  seekVideoTo,
  videoRangeEnd,
  videoRangeLayout,
  videoRangeOf,
  videoRangeStart,
} from '../src/shared/video-range'

const T0 = 1_000_000

function video(partial: Partial<VideoState> = {}): VideoState {
  return { playing: false, anchorSec: 0, anchorAt: null, durationSec: 30, muted: false, range: null, ...partial }
}

function entry(partial: Partial<PlaylistEntry> = {}): PlaylistEntry {
  return {
    id: 'entry-a', kind: 'video', filePath: '/same.mp4', fileName: 'same.mp4',
    displayName: '', speakerName: '', durationMs: 0, ...partial,
  }
}

describe('In/Out range validation', () => {
  it('old/full range is represented as null', () => {
    expect(normalizeVideoRange(null, 30)).toBeNull()
    expect(normalizeVideoRange({ inSec: 0, outSec: 30 }, 30)).toBeNull()
    expect(sanitizeStoredVideoRange(undefined, undefined)).toBeNull()
  })

  it('clamps to duration and rejects In >= Out or non-finite values', () => {
    expect(normalizeVideoRange({ inSec: 12, outSec: 99 }, 30)).toEqual({ inSec: 12, outSec: 30 })
    expect(normalizeVideoRange({ inSec: -5, outSec: 10 }, 30)).toEqual({ inSec: 0, outSec: 10 })
    expect(normalizeVideoRange({ inSec: 10, outSec: 10 }, 30)).toBeNull()
    expect(normalizeVideoRange({ inSec: 20, outSec: 10 }, 30)).toBeNull()
    expect(normalizeVideoRange({ inSec: Number.NaN, outSec: 10 }, 30)).toBeNull()
    expect(normalizeVideoRange({ inSec: 1, outSec: Number.POSITIVE_INFINITY }, 30)).toBeNull()
    expect(sanitizeStoredVideoRange(-1, 10)).toBeNull()
  })

  it('reads bounds from a video playlist entry and clamps by actual duration', () => {
    expect(entryVideoRange(entry({ inSec: 5, outSec: 40 }), 30)).toEqual({ inSec: 5, outSec: 30 })
    expect(entryVideoRange(entry({ kind: 'pdf', inSec: 5, outSec: 20 }), 30)).toBeNull()
    expect(entryVideoRange(entry(), 30)).toBeNull()
  })

  it('duplicate entries keep independent values until deliberately edited', () => {
    const a = entry({ id: 'a', inSec: 2, outSec: 8 })
    const b = entry({ id: 'b' })
    expect(entryVideoRange(a, 30)).toEqual({ inSec: 2, outSec: 8 })
    expect(entryVideoRange(b, 30)).toBeNull()
    b.inSec = 10
    b.outSec = 20
    expect(entryVideoRange(a, 30)).toEqual({ inSec: 2, outSec: 8 })
    expect(entryVideoRange(b, 30)).toEqual({ inSec: 10, outSec: 20 })
  })

  it('layout gives the selected band and marker positions', () => {
    expect(videoRangeLayout({ inSec: 5, outSec: 20 }, 40)).toEqual({
      leftPct: 12.5, widthPct: 37.5, inPct: 12.5, outPct: 50,
    })
    expect(videoRangeLayout(null, 40)).toBeNull()
    expect(videoRangeLayout({ inSec: 5, outSec: 20 }, 0)).toBeNull()
  })
})

describe('bounded seeking, EOF and LOOP', () => {
  const range: VideoRange = { inSec: 10, outSec: 20 }

  it('clamps seeks to In/Out and pauses exactly on Out', () => {
    expect(clampVideoPosition(-3, range, 30)).toBe(10)
    expect(clampVideoPosition(15, range, 30)).toBe(15)
    expect(clampVideoPosition(50, range, 30)).toBe(20)
    expect(seekVideoTo(video({ playing: true, anchorAt: T0 - 1000, range }), 25, T0)).toEqual({
      anchorSec: 20, anchorAt: null, playing: false,
    })
  })

  it('seek inside keeps playing; play from Out restarts at In', () => {
    expect(seekVideoTo(video({ playing: true, anchorSec: 12, range }), 15, T0)).toEqual({
      anchorSec: 15, anchorAt: T0,
    })
    expect(playVideoFrom(video({ anchorSec: 20, range }), 20, T0)).toEqual({
      playing: true, anchorSec: 10, anchorAt: T0,
    })
    expect(videoRangeStart(range, 30)).toBe(10)
    expect(videoRangeEnd(range, 30)).toBe(20)
    expect(isVideoAtStart(10.01, range, 30)).toBe(true)
    expect(isVideoAtStart(10.2, range, 30)).toBe(false)
  })

  it('EOF pauses on Out, LOOP wraps to In', () => {
    expect(endVideo(video({ range, anchorSec: 20 }), false, T0)).toEqual({
      playing: false, anchorSec: 20, anchorAt: null,
    })
    expect(endVideo(video({ range, anchorSec: 20 }), true, T0)).toEqual({
      playing: true, anchorSec: 10, anchorAt: T0,
    })
  })

  it('videoRangeOf uses the applied snapshot, never the pending entry', () => {
    expect(videoRangeOf(video({ range, durationSec: 30 }))).toEqual(range)
    expect(videoRangeOf(video({ range: { inSec: 0, outSec: 30 }, durationSec: 30 }))).toBeNull()
  })
})

describe('TAKE plan with In/Out', () => {
  const range: VideoRange = { inSec: 10, outSec: 20 }

  it('play-start begins at In', () => {
    expect(planVideoTake({
      mode: 'play-start', previewPositionSec: 17, durationSec: 30, range, muted: true, now: T0,
    })).toMatchObject({ playing: true, anchorSec: 10, anchorAt: T0, range, muted: true })
  })

  it('play-resume clamps low/high and holds exactly on Out', () => {
    expect(planVideoTake({
      mode: 'play-resume', previewPositionSec: 2, durationSec: 30, range, muted: false, now: T0,
    })).toMatchObject({ playing: true, anchorSec: 10, range })
    expect(planVideoTake({
      mode: 'play-resume', previewPositionSec: 15, durationSec: 30, range, muted: false, now: T0,
    })).toMatchObject({ playing: true, anchorSec: 15 })
    expect(planVideoTake({
      mode: 'play-resume', previewPositionSec: 25, durationSec: 30, range, muted: false, now: T0,
    })).toMatchObject({ playing: false, anchorSec: 20, anchorAt: null })
  })

  it('hold-first freezes on In', () => {
    expect(planVideoTake({
      mode: 'hold-first', previewPositionSec: 17, durationSec: 30, range, muted: false, now: T0,
    })).toMatchObject({ playing: false, anchorSec: 10, anchorAt: null, range })
  })

  it('legacy full/invalid range behaves like the old full clip', () => {
    expect(planVideoTake({
      mode: 'play-start', previewPositionSec: 0, durationSec: 30, range: null, muted: false, now: T0,
    })).toMatchObject({ playing: true, anchorSec: 0 })
    expect(planVideoTake({
      mode: 'play-start', previewPositionSec: 0, durationSec: 30,
      range: { inSec: 20, outSec: 20 }, muted: false, now: T0,
    })).toMatchObject({ playing: true, anchorSec: 0 })
  })

  it('duration clamp wins over a stale stored Out', () => {
    expect(planVideoTake({
      mode: 'play-start', previewPositionSec: 0, durationSec: 15,
      range: { inSec: 5, outSec: 40 }, muted: false, now: T0,
    })).toMatchObject({ anchorSec: 5, range: { inSec: 5, outSec: 15 } })
  })
})

describe('reused-source duration', () => {
  it('keeps the retained decoder duration when the same path+sha is activated again', () => {
    const previous = {
      path: '/vfr.mp4', sha1: 'same-sha', kind: 'video' as const,
      video: video({ durationSec: 1.625 }),
    }
    expect(reusedVideoDuration(previous, '/vfr.mp4', 'same-sha', 'video')).toBe(1.625)
    expect(reusedVideoDuration(previous, '/vfr.mp4', 'other-sha', 'video')).toBe(0)
    expect(reusedVideoDuration(previous, '/other.mp4', 'same-sha', 'video')).toBe(0)
    expect(reusedVideoDuration(previous, '/vfr.mp4', 'same-sha', 'pptx')).toBe(0)
  })
})
