import type { AppState } from './types.js'

/** Appearance only: elapsed time, duration, mode and running state are preserved. */
export function defaultSpeakerTimerStyle(): Pick<AppState, 'timerPosition' | 'timerScale' | 'timerFree' | 'timerFont' | 'timerColor' | 'timerWarnColors'> {
  return { timerPosition: 'top-right', timerScale: 1, timerFree: { x: 0.85, y: 0.12 }, timerFont: 'system', timerColor: null, timerWarnColors: true }
}
