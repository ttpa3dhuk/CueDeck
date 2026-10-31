import { describe, expect, it } from 'vitest'
import {
  exactFrameTimecodeAt,
  formatFrameTimecode,
  frameTimecodeAt,
  totalFrameTimecodeAt,
} from '../src/shared/frame-timecode'
import type { FrameTimeline } from '../src/shared/frame-timeline'

function timeline(timestamps: number[], window?: FrameTimeline['window']): FrameTimeline {
  return { timestamps, ...(window ? { window } : {}) }
}

const vfr = [0, 0.04, 0.16, 0.2, 0.32, 0.36, 0.48, 0.52, 0.64, 0.68, 0.8]

describe('MM:SS:FF from actual decoded frame timestamps', () => {
  it('uses actual frame positions for 25/30/50/60 fps, not an assumed rate', () => {
    for (const [fps, target, expected] of [
      [25, 0.08, '00:00:02'],
      [30, 0.1, '00:00:03'],
      [50, 0.1, '00:00:05'],
      [60, 0.1, '00:00:06'],
    ] as const) {
      const frames = Array.from({ length: fps }, (_, i) => i / fps)
      expect(frameTimecodeAt(timeline(frames), target), `${fps} fps`).toBe(expected)
    }
  })

  it('handles 24000/1001 and 30000/1001 without inventing a constant rate', () => {
    const f23976 = Array.from({ length: 30 }, (_, i) => i * 1001 / 24000)
    const f2997 = Array.from({ length: 36 }, (_, i) => i * 1001 / 30000)
    expect(frameTimecodeAt(timeline(f23976), f23976[2])).toBe('00:00:02')
    expect(frameTimecodeAt(timeline(f2997), f2997[3])).toBe('00:00:03')
    expect(frameTimecodeAt(timeline(f23976), 1.001)).toBe('00:01:00')
    expect(frameTimecodeAt(timeline(f2997), 1.001)).toBe('00:01:00')
  })

  it('uses actual in-second indices for VFR, including gaps', () => {
    expect(frameTimecodeAt(timeline(vfr), 0.2)).toBe('00:00:03')
    expect(frameTimecodeAt(timeline(vfr), 0.32)).toBe('00:00:04')
    expect(frameTimecodeAt(timeline(vfr), 0.48)).toBe('00:00:06')
    expect(frameTimecodeAt(timeline(vfr), 0.8)).toBe('00:00:10')
  })

  it('shows unknown frame as -- when the second boundary was not scanned', () => {
    const partial = timeline([0.54, 0.58], { startSec: 0.5, endSec: 2 })
    expect(frameTimecodeAt(partial, 0.58)).toBe('00:00:--')
    expect(frameTimecodeAt(timeline([0.54, 0.58], { startSec: 0, endSec: 2 }), 0.58)).toBe('00:00:01')
  })

  it('uses an exclusive end boundary count for totals', () => {
    const frames = [0, 0.04, 0.08, 1.0, 1.5]
    expect(totalFrameTimecodeAt(timeline(frames), 1.625)).toBe('00:01:02')
    expect(exactFrameTimecodeAt(timeline(frames), 1.625)).toBeNull()
    expect(exactFrameTimecodeAt(timeline(frames), 1.5)).toBe('00:01:01')
  })

  it('handles ordinary 21 s CFR, 25 fps, 29.97 and VFR end boundaries', () => {
    const cfr21 = Array.from({ length: 630 }, (_, i) => i / 30)
    expect(totalFrameTimecodeAt(timeline(cfr21), 21)).toBe('00:21:00')
    const cfr25 = Array.from({ length: 100 }, (_, i) => i / 25)
    expect(totalFrameTimecodeAt(timeline(cfr25), 4)).toBe('00:04:00')
    const f2997 = Array.from({ length: 121 }, (_, i) => i * 1001 / 30000)
    expect(totalFrameTimecodeAt(timeline(f2997), 4.004)).toBe('00:04:00')
    expect(totalFrameTimecodeAt(timeline(vfr), 0.52)).toBe('00:00:07')
  })

  it('returns unknown total when coverage or duration is uncertain', () => {
    expect(totalFrameTimecodeAt(timeline([20.5, 20.54], { startSec: 18, endSec: 21 }), 20.9)).toBeNull()
    expect(totalFrameTimecodeAt(timeline([19.9, 20.0, 20.5, 20.54], { startSec: 18, endSec: 21 }), 20.9)).toBe('00:20:03')
    expect(totalFrameTimecodeAt(timeline([20.5, 20.54], { startSec: 18, endSec: 21 }), 21)).toBe('00:21:00')
    expect(totalFrameTimecodeAt(timeline([0, 0.04], { startSec: 0, endSec: 1 }), 4)).toBeNull()
    expect(totalFrameTimecodeAt(timeline([0, 0.04]), Number.NaN)).toBeNull()
  })

  it('requires returned coverage before a second boundary', () => {
    const uncertain = timeline([20.5, 20.54], { startSec: 18, endSec: 21 })
    expect(frameTimecodeAt(uncertain, 20.6)).toBe('00:20:--')
    const keyframed = timeline([19.9, 20.0, 20.5, 20.54], { startSec: 18, endSec: 21 })
    expect(frameTimecodeAt(keyframed, 20.6)).toBe('00:20:02')
    const origin = timeline([0.5, 1.0, 1.2], { startSec: 0, endSec: 2 })
    expect(frameTimecodeAt(origin, 1.2)).toBe('00:01:01')
  })

  it('reports range boundaries at their containing decoded frame', () => {
    const frames = Array.from({ length: 50 }, (_, i) => i / 25)
    expect(frameTimecodeAt(timeline(frames), 0.5)).toBe('00:00:12')
    expect(frameTimecodeAt(timeline(frames), 1.25)).toBe('00:01:06')
  })
})
