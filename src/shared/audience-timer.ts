import type { TimerMode, TimerState } from './types.js'

export interface AudienceTimerConfig {
  durationMs: number
  mode: TimerMode
  position: { x: number; y: number }
  scale: number
  color: string
  backgroundColor: string | null
  backgroundOpacity: number
  font: 'system' | 'mono' | 'serif'
  tickEnabled: boolean
  gongEnabled: boolean
  loop: boolean
  warnColors: boolean
}
export interface AudienceTimerState extends AudienceTimerConfig, TimerState {
  visible: boolean
}
export const DEFAULT_AUDIENCE_TIMER: AudienceTimerConfig = {
  durationMs: 5 * 60_000,
  mode: 'countdown',
  position: { x: 0.85, y: 0.88 },
  scale: 1,
  color: '#ffffff',
  backgroundColor: '#000000',
  backgroundOpacity: 0.8,
  font: 'mono',
  tickEnabled: false,
  gongEnabled: false,
  loop: false,
  warnColors: false,
}
const number = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback
const color = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^#[a-f\d]{6}$/i.test(v) ? v.toLowerCase() : fallback

/** Only configuration is persisted; a saved project never resumes a live countdown. */
export function audienceTimerConfig(value: unknown): AudienceTimerConfig {
  const raw = value && typeof value === 'object' ? value as Partial<AudienceTimerConfig> : {}
  return {
    mode: raw.mode === 'clock' || raw.mode === 'stopwatch' ? raw.mode : 'countdown',
    durationMs: Math.floor(number(raw.durationMs, 0, 24 * 60 * 60_000, DEFAULT_AUDIENCE_TIMER.durationMs)),
    position: {
      x: number(raw.position?.x, 0, 1, DEFAULT_AUDIENCE_TIMER.position.x),
      y: number(raw.position?.y, 0, 1, DEFAULT_AUDIENCE_TIMER.position.y),
    },
    scale: number(raw.scale, 0.3, 3, DEFAULT_AUDIENCE_TIMER.scale),
    color: color(raw.color, DEFAULT_AUDIENCE_TIMER.color),
    backgroundColor: raw.backgroundColor === null ? null : color(raw.backgroundColor, '#000000'),
    backgroundOpacity: number(raw.backgroundOpacity, 0, 1, DEFAULT_AUDIENCE_TIMER.backgroundOpacity),
    font: raw.font === 'system' || raw.font === 'serif' ? raw.font : 'mono',
    tickEnabled: raw.tickEnabled === true,
    gongEnabled: raw.gongEnabled === true,
    loop: raw.loop === true,
    warnColors: raw.warnColors === true,
  }
}
export function createAudienceTimer(config?: unknown): AudienceTimerState {
  return { ...audienceTimerConfig(config), visible: false, startedAt: null, elapsedMs: 0, running: false, cycles: 0 }
}
export function audienceTimerAction(
  timer: AudienceTimerState, action: 'start' | 'pause' | 'reset', now = Date.now(),
): AudienceTimerState {
  if (action === 'start') return timer.running ? timer : { ...timer, visible: true, running: true, startedAt: now }
  if (action === 'pause') return !timer.running || timer.startedAt === null ? timer : {
    ...timer, running: false, startedAt: null, elapsedMs: timer.elapsedMs + Math.max(0, now - timer.startedAt),
  }
  return { ...timer, startedAt: null, elapsedMs: 0, running: false, cycles: 0 }
}
