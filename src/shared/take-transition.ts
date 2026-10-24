export const DEFAULT_TAKE_FADE_MS = 300
export const TAKE_FADE_MAX_MS = 2000

export function sanitizeTakeFadeMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(100, Math.min(TAKE_FADE_MAX_MS, Math.round(value)))
    : DEFAULT_TAKE_FADE_MS
}

/** One-shot event, never persisted or replayed when a window is created. */
export interface TakeTransition {
  id: string
  durationMs: number
  /** In-place slide navigation keeps media on the program route. */
  scope?: 'slide'
}
