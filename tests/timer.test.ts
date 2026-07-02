import { describe, expect, it } from 'vitest'
import { elapsedMs, formatMs, remainingMs, timerColor, timerView } from '../src/renderer/shared/timer'
import type { TimerState } from '../src/shared/types'

const T0 = 1_000_000

function timer(partial: Partial<TimerState> = {}): TimerState {
  return { durationMs: 10 * 60_000, startedAt: null, elapsedMs: 0, running: false, ...partial }
}

describe('elapsedMs', () => {
  it('стоит на elapsedMs, пока таймер не запущен', () => {
    expect(elapsedMs(timer({ elapsedMs: 5000 }), T0)).toBe(5000)
  })

  it('идёт от startedAt, когда запущен', () => {
    const t = timer({ running: true, startedAt: T0, elapsedMs: 2000 })
    expect(elapsedMs(t, T0 + 3000)).toBe(5000)
  })

  it('running без startedAt не взрывается (пауза сбрасывает startedAt)', () => {
    const t = timer({ running: true, startedAt: null, elapsedMs: 7000 })
    expect(elapsedMs(t, T0)).toBe(7000)
  })
})

describe('remainingMs', () => {
  it('duration - elapsed', () => {
    const t = timer({ durationMs: 60_000, elapsedMs: 20_000 })
    expect(remainingMs(t, T0)).toBe(40_000)
  })

  it('уходит в минус на овертайме', () => {
    const t = timer({ durationMs: 1000, running: true, startedAt: T0 })
    expect(remainingMs(t, T0 + 5000)).toBe(-4000)
  })
})

describe('timerColor', () => {
  it('красный при remaining <= 0 (овертайм)', () => {
    expect(timerColor(0, 60_000)).toBe('red')
    expect(timerColor(-1, 60_000)).toBe('red')
  })

  it('зелёный при нулевой длительности и положительном остатке', () => {
    expect(timerColor(1, 0)).toBe('green')
  })

  it('пороги: <10% красный, <33% жёлтый, иначе зелёный', () => {
    expect(timerColor(5_999, 60_000)).toBe('red')
    expect(timerColor(6_000, 60_000)).toBe('yellow')
    expect(timerColor(19_799, 60_000)).toBe('yellow')
    expect(timerColor(19_800, 60_000)).toBe('green')
    expect(timerColor(60_000, 60_000)).toBe('green')
  })
})

describe('formatMs', () => {
  it('MM:SS без часов', () => {
    expect(formatMs(0)).toBe('00:00')
    expect(formatMs(65_000)).toBe('01:05')
  })

  it('HH:MM:SS с часами', () => {
    expect(formatMs(3_661_000)).toBe('01:01:01')
  })

  it('минус только при signed', () => {
    expect(formatMs(-65_000)).toBe('01:05')
    expect(formatMs(-65_000, true)).toBe('−01:05')
  })

  it('усечение до целой секунды', () => {
    expect(formatMs(999)).toBe('00:00')
    expect(formatMs(1999)).toBe('00:01')
  })
})

describe('timerView', () => {
  it('countdown: остаток, цвет, овертайм', () => {
    const t = timer({ durationMs: 60_000, running: true, startedAt: T0 })
    const v = timerView(t, 'countdown', T0 + 70_000)
    expect(v.text).toBe('−00:10')
    expect(v.color).toBe('red')
    expect(v.overtime).toBe(true)
  })

  it('stopwatch: счёт вверх, нейтральный цвет, без овертайма', () => {
    const t = timer({ durationMs: 1000, running: true, startedAt: T0 })
    const v = timerView(t, 'stopwatch', T0 + 90_000)
    expect(v.text).toBe('01:30')
    expect(v.color).toBe('neutral')
    expect(v.overtime).toBe(false)
  })

  it('clock: системное время, состояние таймера игнорируется', () => {
    const now = new Date(2026, 0, 1, 9, 5, 7).getTime()
    const v = timerView(timer(), 'clock', now)
    expect(v.text).toBe('09:05:07')
    expect(v.color).toBe('neutral')
  })

  it('пауза замораживает значение', () => {
    const t = timer({ durationMs: 60_000, elapsedMs: 30_000, running: false })
    expect(timerView(t, 'countdown', T0).text).toBe(timerView(t, 'countdown', T0 + 99_000).text)
  })
})
