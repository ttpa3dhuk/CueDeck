import type { FileKind, TimerMode, TimerState } from './types.js'

export interface MaterialSettings { defaultDurationMs: number; autoStartTimer: boolean }
export const DEFAULT_MATERIAL_SETTINGS: MaterialSettings = { defaultDurationMs: 0, autoStartTimer: false }
export function validMaterialDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 999 * 60_000 && Number.isInteger(value)
}
export function sanitizeMaterialSettings(value: unknown): MaterialSettings {
  const v = value as Partial<MaterialSettings> | null
  return {
    defaultDurationMs: validMaterialDuration(v?.defaultDurationMs) ? v.defaultDurationMs : 0,
    autoStartTimer: v?.autoStartTimer === true,
  }
}
/** Called on a material TAKE, never on slide navigation or preview load. */
export function materialTakeTimer(durationMs: number, kind: FileKind | null, mode: TimerMode, auto: boolean, now: number): TimerState {
  const running = auto && durationMs > 0 && mode === 'countdown' && (kind === 'pdf' || kind === 'pptx')
  return { durationMs, elapsedMs: 0, cycles: 0, running, startedAt: running ? now : null }
}
