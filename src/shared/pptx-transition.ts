/** Ordinary crossfade only. Fade-through-black and unrelated effects stay cuts.
 * https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-add-transitions-between-slides-in-a-presentation
 */
export function pptxFadeDuration(xml: string): number {
  for (const candidate of transitionCandidates(xml)) {
    const effect = parseTransition(candidate)
    if (!effect) continue
    return effect.kind === 'fade' ? effect.durationMs : 0
  }
  return 0
}

export type PushDirection = 'l' | 'r' | 'u' | 'd'
export type OrientationDirection = 'horz' | 'vert'
export type PptxDirectionalEffect = { kind: 'push' | 'wipe' | 'cover' | 'pull'; direction: PushDirection; durationMs: number }
export type PptxSlideTransition = number | PptxDirectionalEffect |
  { kind: 'fade' | 'fade-black' | 'circle'; durationMs: number } |
  { kind: 'comb' | 'doors'; direction: OrientationDirection; durationMs: number }

function transitionCandidates(xml: string): string[] {
  // PowerPoint 2010+ stores its real effect in mc:Choice and a downgraded
  // substitute (often Fade) in mc:Fallback. Never select both.
  const alternate = [...xml.matchAll(/<mc:AlternateContent\b[^>]*>[\s\S]*?<\/mc:AlternateContent>/g)]
    .find(block => block[0].includes('<p:transition'))?.[0]
  if (alternate) {
    const choices = [...alternate.matchAll(/<mc:Choice\b([^>]*)>([\s\S]*?)<\/mc:Choice>/g)]
    const supported = choices.find(choice => {
      const required = choice[1].match(/\bRequires="([^"]+)"/)?.[1]?.split(/\s+/) ?? []
      return required.length > 0 && required.every(prefix => prefix === 'p14')
    })?.[2]
    const fallback = alternate.match(/<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/)?.[1]
    return [supported, fallback].flatMap(part => part?.match(/<p:transition\b[^>]*>[\s\S]*?<\/p:transition>/)?.[0] ?? [])
  }
  return [xml.match(/<p:transition\b[^>]*>[\s\S]*?<\/p:transition>/)?.[0]].filter((part): part is string => Boolean(part))
}

function parseTransition(transitionXml: string): Exclude<PptxSlideTransition, number> | null {
  const transition = transitionXml.match(/<p:transition\b([^>]*)>([\s\S]*?)<\/p:transition>/)
  if (!transition) return null
  const effect = transition[2].match(/<(p|p14):(push|wipe|cover|pull|fade|comb|doors|circle)\b([^>]*)\/?\s*>/)
  if (!effect) return null
  const [, namespace, kind, attrs] = effect
  if (kind === 'doors' ? namespace !== 'p14' : namespace !== 'p') return null
  const explicit = transition[1].match(/\bp14:dur="(\d+)"/)?.[1]
  const speed = transition[1].match(/\bspd="(slow|med|fast)"/)?.[1]
  const durationMs = explicit !== undefined ? Math.min(10000, Number(explicit))
    : kind === 'fade' ? 400 : speed === 'slow' ? 1000 : speed === 'fast' ? 350 : 650
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null
  if (kind === 'fade') return { kind: /\bthruBlk="(?:1|true)"/.test(attrs) ? 'fade-black' : 'fade', durationMs }
  if (kind === 'circle') return { kind, durationMs }
  if (kind === 'comb' || kind === 'doors') {
    const direction = attrs.match(/\bdir="([^"]+)"/)?.[1] ?? 'horz'
    return direction === 'horz' || direction === 'vert' ? { kind, direction, durationMs } : null
  }
  const direction = attrs.match(/\bdir="([^"]+)"/)?.[1] ?? 'l'
  if (!['l', 'r', 'u', 'd'].includes(direction)) return null
  return { kind: kind as PptxDirectionalEffect['kind'], direction: direction as PushDirection, durationMs }
}

export function pptxSlideTransition(xml: string): PptxSlideTransition {
  for (const candidate of transitionCandidates(xml)) {
    const parsed = parseTransition(candidate)
    if (parsed) return parsed
  }
  return 0
}

export function pushOffset(direction: PushDirection, width: number, height: number): { x: number; y: number } {
  switch (direction) {
    case 'l': return { x: -width, y: 0 }
    case 'r': return { x: width, y: 0 }
    case 'u': return { x: 0, y: -height }
    case 'd': return { x: 0, y: height }
  }
}
