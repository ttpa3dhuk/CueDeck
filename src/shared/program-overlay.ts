export interface ProgramOverlayConfig {
  enabled: boolean
  mode: 'text' | 'image'
  text: string
  path: string | null
  x: number; y: number; w: number; h: number
  fontSize: number
  color: string
  background: string
  opacity: number
}
export const DEFAULT_PROGRAM_OVERLAY: ProgramOverlayConfig = {
  enabled: false, mode: 'text', text: '', path: null, x: .05, y: .78, w: .9, h: .16,
  fontSize: 52, color: '#ffffff', background: '#101724', opacity: .85,
}
const clamp = (value: unknown, fallback: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, typeof value === 'number' && Number.isFinite(value) ? value : fallback))
const color = (value: unknown, fallback: string): string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
export function programOverlay(value: unknown): ProgramOverlayConfig {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<ProgramOverlayConfig>
  const d = DEFAULT_PROGRAM_OVERLAY
  const x = clamp(v.x, d.x, 0, .95), y = clamp(v.y, d.y, 0, .95)
  return { enabled: v.enabled === true, mode: v.mode === 'image' ? 'image' : 'text',
    text: typeof v.text === 'string' ? v.text.slice(0, 2000) : '', path: typeof v.path === 'string' && v.path ? v.path : null,
    x, y, w: clamp(v.w, d.w, .05, 1-x), h: clamp(v.h, d.h, .05, 1-y),
    fontSize: clamp(v.fontSize, d.fontSize, 16, 240), color: color(v.color, d.color), background: color(v.background, d.background),
    opacity: clamp(v.opacity, d.opacity, 0, 1) }
}
