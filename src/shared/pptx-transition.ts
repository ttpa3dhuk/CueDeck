/** Ordinary crossfade only. Fade-through-black and unrelated effects stay cuts.
 * https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-add-transitions-between-slides-in-a-presentation
 */
export function pptxFadeDuration(xml: string): number {
  const transition = xml.match(/<p:transition\b([^>]*)>([\s\S]*?)<\/p:transition>/)
  if (!transition || !/<p:fade\b/.test(transition[2]) || /thruBlk="(?:1|true)"/.test(transition[2])) return 0
  const duration = transition[1].match(/\bp14:dur="(\d+)"/)
  if (duration) return Math.max(0, Math.min(10000, Number(duration[1])))
  // Legacy speed is not an exact duration. Use the accepted CueDeck default.
  return 400
}

export type PushDirection = 'l' | 'r' | 'u' | 'd'
export type PptxDirectionalEffect = { kind: 'push' | 'wipe' | 'cover' | 'pull'; direction: PushDirection; durationMs: number }
export type PptxSlideTransition = number | PptxDirectionalEffect | { kind: 'fade' | 'fade-black'; durationMs: number }

export function pptxSlideTransition(xml: string): PptxSlideTransition {
  const transition = xml.match(/<p:transition\b([^>]*)>([\s\S]*?)<\/p:transition>/)
  if (!transition) return 0
  const effect = transition[2].match(/<p:(push|wipe|cover|pull|fade)\b([^>]*)\/?\s*>/)
  if (!effect) return 0
  const explicit = transition[1].match(/\bp14:dur="(\d+)"/)?.[1]
  const speed = transition[1].match(/\bspd="(slow|med|fast)"/)?.[1]
  // Legacy files only encode a pace. Keep the order even without an explicit duration.
  const durationMs = explicit !== undefined ? Math.min(10000, Number(explicit))
    : effect[1] === 'fade' ? pptxFadeDuration(xml) || 400 : speed === 'slow' ? 1000 : speed === 'fast' ? 350 : 650
  if (durationMs <= 0) return 0
  if (effect[1] === 'fade') return { kind: /\bthruBlk="(?:1|true)"/.test(effect[2]) ? 'fade-black' : 'fade', durationMs }
  const direction = effect[2].match(/\bdir="([^"]+)"/)?.[1] ?? 'l'
  if (!['l', 'r', 'u', 'd'].includes(direction)) return 0
  return { kind: effect[1] as PptxDirectionalEffect['kind'], direction: direction as PushDirection, durationMs }
}

export function pushOffset(direction: PushDirection, width: number, height: number): { x: number; y: number } {
  switch (direction) {
    case 'l': return { x: -width, y: 0 }
    case 'r': return { x: width, y: 0 }
    case 'u': return { x: 0, y: -height }
    case 'd': return { x: 0, y: height }
  }
}
