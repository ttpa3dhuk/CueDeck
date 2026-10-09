import type { TimerMode, TimerState } from '../../preload/api'

export type TimerColor = 'green' | 'yellow' | 'red' | 'neutral'

export interface TimerView {
  text: string
  color: TimerColor
  overtime: boolean
}

export function elapsedMs(timer: TimerState, now: number = Date.now()): number {
  if (timer.running && timer.startedAt !== null) {
    return timer.elapsedMs + (now - timer.startedAt)
  }
  return timer.elapsedMs
}

export function remainingMs(timer: TimerState, now: number = Date.now()): number {
  return timer.durationMs - elapsedMs(timer, now)
}

/**
 * Кнопки ± у таймера. Обратный отсчёт — сдвигает длительность, секундомер —
 * показанное время (идущий секундомер перепривязывается к «сейчас»), не ниже 0.
 * Часы — null: сдвигать нечего.
 */
export function adjustPatch(
  timer: TimerState,
  mode: TimerMode,
  deltaMs: number,
  now: number = Date.now(),
): Partial<TimerState> | null {
  const d = Math.floor(deltaMs)
  if (mode === 'clock') return null
  if (mode === 'stopwatch') {
    const shown = Math.max(0, elapsedMs(timer, now) + d)
    return timer.running && timer.startedAt !== null
      ? { elapsedMs: shown, startedAt: now }
      : { elapsedMs: shown }
  }
  return { durationMs: Math.max(0, timer.durationMs + d) }
}

export function timerColor(remaining: number, duration: number): TimerColor {
  if (remaining <= 0) return 'red'
  if (duration <= 0) return 'green'
  const pct = remaining / duration
  if (pct < 0.1) return 'red'
  if (pct < 0.33) return 'yellow'
  return 'green'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatMs(ms: number, signed: boolean = false): string {
  const negative = ms < 0
  const totalSec = Math.floor(Math.abs(ms) / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const body = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  if (signed && negative) return `−${body}`
  return body
}

function formatClock(now: number): string {
  const d = new Date(now)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function timerView(
  timer: TimerState,
  mode: TimerMode,
  now: number = Date.now(),
): TimerView {
  if (mode === 'clock') {
    return { text: formatClock(now), color: 'neutral', overtime: false }
  }
  if (mode === 'stopwatch') {
    return { text: formatMs(elapsedMs(timer, now)), color: 'neutral', overtime: false }
  }
  // countdown
  const remaining = remainingMs(timer, now)
  return {
    text: formatMs(remaining, true),
    color: timerColor(remaining, timer.durationMs),
    overtime: remaining < 0,
  }
}

export function startTick(intervalMs: number, fn: () => void): () => void {
  fn()
  const id = window.setInterval(fn, intervalMs)
  return () => window.clearInterval(id)
}
