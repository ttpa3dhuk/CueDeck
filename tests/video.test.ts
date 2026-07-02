import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioRole, formatClock, shouldMute, videoPosition, videoSrc } from '../src/renderer/shared/video'
import type { AppState, Layout, VideoState } from '../src/shared/types'

function video(partial: Partial<VideoState> = {}): VideoState {
  return { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: false, ...partial }
}

const T0 = 1_000_000

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
