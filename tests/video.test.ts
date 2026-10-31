import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioRole, formatClock, knownElementDuration, shouldMute, syncVideoElement, videoPosition, videoSrc } from '../src/renderer/shared/video'
import type { AppState, Layout, VideoState } from '../src/shared/types'

function video(partial: Partial<VideoState> = {}): VideoState {
  return { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: false, ...partial }
}

const T0 = 1_000_000

describe('syncVideoElement: unfinished decoder seek', () => {
  function element() {
    let position = 0
    const writes: number[] = []
    const el = {
      seeking: false, paused: true, src: 'source-a',
      get currentTime() { return position },
      set currentTime(value: number) { writes.push(value); position = value; this.seeking = true },
      play: vi.fn(async () => { el.paused = false }),
      pause: vi.fn(() => { el.paused = true }),
    }
    return { el, writes, sync: (v: VideoState) => syncVideoElement(el as unknown as HTMLVideoElement, v) }
  }

  it('does not restart a slow seek as the shared clock advances; catches up after completion', () => {
    const { el, writes, sync } = element()
    const clock = video({ playing: true, anchorSec: 10, anchorAt: T0 })
    sync(clock)
    for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(250); sync(clock) }
    expect(writes).toEqual([10])
    el.seeking = false
    sync(clock)
    expect(writes).toEqual([10, 15])
  })

  it('pauses during a pending seek and applies the newest manual target after completion', () => {
    const { el, writes, sync } = element()
    sync(video({ playing: true, anchorSec: 10 }))
    sync(video({ anchorSec: 20 }))
    sync(video({ anchorSec: 30 }))
    expect(el.pause).toHaveBeenCalledOnce()
    expect(writes).toEqual([10])
    el.seeking = false
    sync(video({ anchorSec: 30 }))
    expect(writes).toEqual([10, 30])
    expect(el.paused).toBe(true)
  })

  it('applies a loop reset after a pending end seek completes', () => {
    const { el, writes, sync } = element()
    sync(video({ playing: true, anchorSec: 31 }))
    sync(video({ playing: true, anchorSec: 0, anchorAt: T0 }))
    expect(writes).toEqual([31])
    el.seeking = false
    sync(video({ playing: true, anchorSec: 0, anchorAt: T0 }))
    expect(writes).toEqual([31, 0])
  })

  it('does not keep restarting a stuck browser seek, but still allows pause', () => {
    const { el, writes, sync } = element()
    sync(video({ playing: true, anchorSec: 10, anchorAt: T0 }))
    vi.advanceTimersByTime(60_000)
    sync(video({ anchorSec: 50 }))
    expect(writes).toEqual([10])
    expect(el.paused).toBe(true)
  })

  it('forces an explicit seek even when one frame is below the drift threshold', () => {
    const { el, writes, sync } = element()
    sync(video({ anchorSec: 10, seekSeq: 1 }))
    expect(writes).toEqual([10])
    el.seeking = false
    sync(video({ anchorSec: 10.04, seekSeq: 2 }))
    expect(writes).toEqual([10, 10.04])
    el.seeking = false
    sync(video({ anchorSec: 10.04, seekSeq: 2 }))
    expect(writes).toEqual([10, 10.04])
  })

  it('lands a one-frame target on a fresh element and after a source change', () => {
    const { el, writes, sync } = element()
    sync(video({ anchorSec: 0.04, seekSeq: 0 }))
    expect(writes).toEqual([0.04])
    el.seeking = false
    sync(video({ anchorSec: 0.04, seekSeq: 0 }))
    expect(writes).toEqual([0.04])
    el.seeking = false
    el.src = 'source-b'
    sync(video({ anchorSec: 0.2, seekSeq: 0 }))
    expect(writes).toEqual([0.04, 0.2])
  })

  it('freezes the element on Out without asking main from non-operator windows', () => {
    const { el, sync } = element()
    el.paused = false
    sync(video({ playing: true, anchorSec: 20, anchorAt: T0, durationSec: 30, range: { inSec: 10, outSec: 20 } }))
    expect(el.pause).toHaveBeenCalled()
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('videoPosition (логические часы воспроизведения)', () => {
  it('на паузе — ровно anchorSec', () => {
    expect(videoPosition(video({ anchorSec: 42 }))).toBe(42)
  })

  it('при воспроизведении — anchorSec + прошедшее время', () => {
    const v = video({ playing: true, anchorSec: 10, anchorAt: T0 - 5000 })
    expect(videoPosition(v)).toBe(15)
  })

  it('клампится к длительности', () => {
    const v = video({ playing: true, anchorSec: 10, anchorAt: T0 - 60_000, durationSec: 30 })
    expect(videoPosition(v)).toBe(30)
  })

  it('без известной длительности не клампится', () => {
    const v = video({ playing: true, anchorSec: 10, anchorAt: T0 - 60_000, durationSec: 0 })
    expect(videoPosition(v)).toBe(70)
  })

  it('playing без anchorAt (защитный случай) — anchorSec', () => {
    expect(videoPosition(video({ playing: true, anchorSec: 7, anchorAt: null }))).toBe(7)
  })

  it('клампится к применённому In/Out', () => {
    const range = { inSec: 10, outSec: 20 }
    expect(videoPosition(video({ anchorSec: 5, durationSec: 30, range }))).toBe(10)
    expect(videoPosition(video({ playing: true, anchorSec: 15, anchorAt: T0 - 60_000, durationSec: 30, range }))).toBe(20)
  })
})

describe('audioRole (кто озвучивает)', () => {
  it('solo → оператор', () => {
    expect(audioRole('solo')).toBe('operator')
  })

  it('с залом → зал', () => {
    expect(audioRole('presenter-audience')).toBe('audience')
    expect(audioRole('operator-speaker-audience')).toBe('audience')
  })
})

describe('shouldMute (кто молчит)', () => {
  function state(layout: Layout, partial: Partial<AppState> = {}): AppState {
    return { layout, blackout: false, video: video(), ...partial } as AppState
  }

  it('звучит только audio-роль: зал при наличии, оператор в solo', () => {
    expect(shouldMute(state('presenter-audience'), 'audience')).toBe(false)
    expect(shouldMute(state('presenter-audience'), 'operator')).toBe(true)
    expect(shouldMute(state('solo'), 'operator')).toBe(false)
  })

  it('суфлёр всегда молчит', () => {
    expect(shouldMute(state('operator-speaker-audience'), 'speaker')).toBe(true)
  })

  it('глобальный мьют глушит audio-роль', () => {
    expect(shouldMute(state('solo', { video: video({ muted: true }) }), 'operator')).toBe(true)
  })

  it('blackout глушит звук зала (полная заглушка)', () => {
    expect(shouldMute(state('presenter-audience', { blackout: true }), 'audience')).toBe(true)
    expect(shouldMute(state('solo', { blackout: true }), 'operator')).toBe(true)
  })
})

describe('videoSrc', () => {
  it('кодирует деск и cache-buster', () => {
    expect(videoSrc('abc123', 'program')).toBe('cuedeck-media://stream/program?v=abc123')
    expect(videoSrc('abc123', 'preview')).toBe('cuedeck-media://stream/preview?v=abc123')
  })

  it('по умолчанию — program', () => {
    expect(videoSrc('x')).toContain('/program?')
  })
})

describe('formatClock', () => {
  it('MM:SS', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(75)).toBe('01:15')
  })

  it('H:MM:SS с часами', () => {
    expect(formatClock(3675)).toBe('1:01:15')
  })

  it('мусор и минус → 00:00', () => {
    expect(formatClock(-5)).toBe('00:00')
    expect(formatClock(NaN)).toBe('00:00')
    expect(formatClock(Infinity)).toBe('00:00')
  })
})

describe('retained element duration', () => {
  const src = videoSrc('same-sha', 'preview')
  function element(partial: { duration?: number; readyState?: number; src?: string } = {}) {
    return {
      duration: partial.duration ?? 1.625,
      readyState: partial.readyState ?? 1,
      getAttribute: () => partial.src ?? src,
    }
  }

  it('reports the real element duration when main reset state to zero', () => {
    expect(knownElementDuration(element(), src, 0)).toBe(1.625)
    expect(knownElementDuration(element({ duration: 1.625 }), src, 1.625)).toBeNull()
  })

  it('does not apply an old element duration to a new source or unloaded element', () => {
    expect(knownElementDuration(element({ src: videoSrc('other-sha', 'preview') }), src, 0)).toBeNull()
    expect(knownElementDuration(element({ readyState: 0 }), src, 0)).toBeNull()
    expect(knownElementDuration(element({ duration: Number.NaN }), src, 0)).toBeNull()
  })
})
