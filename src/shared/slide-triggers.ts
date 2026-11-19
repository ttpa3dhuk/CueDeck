import type { SlideForegroundStep, SlideInteractiveLayer, SlideTrigger, SlideTriggerState } from './types'

export function slideActorAt(layer: SlideInteractiveLayer, state: SlideTriggerState | undefined, now: number) {
  const chain = layer.shape ? state?.actors[layer.shape] ?? [] : []
  let effect: SlideForegroundStep | undefined
  let pending = false
  for (const step of chain) {
    if (step.startMs > now) { pending = true; break }
    effect = step
  }
  const elapsed = effect ? now - effect.startMs : 0
  const progress = effect ? Math.min(1, elapsed / effect.durationMs) : 0
  const value = effect ? {
    x: effect.from.x + (effect.to.x - effect.from.x) * progress,
    y: effect.from.y + (effect.to.y - effect.from.y) * progress,
    opacity: effect.from.opacity + (effect.to.opacity - effect.from.opacity) * progress,
  } : { x: 0, y: 0, opacity: layer.initiallyHidden ? 0 : 1 }
  return { effect, elapsed, value, playing: pending || Boolean(effect && (progress < 1 || effect.rotations?.length)) }
}

export function startSlideTrigger(
  trigger: SlideTrigger, layers: SlideInteractiveLayer[], previous: SlideTriggerState | undefined, now: number,
): SlideTriggerState | null {
  const last = previous?.runs[trigger.id]
  if (last !== undefined && (trigger.restart === 'never' ||
      trigger.restart === 'whenNotActive' && now < last + trigger.durationMs)) return null
  const button = layers.find(layer => layer.shape === trigger.shape)
  if (button && slideActorAt(button, previous, now).value.opacity <= 0) return null
  const actors = { ...previous?.actors }
  const effectsByShape = new Map<string, SlideForegroundStep[]>()
  for (const { shape, ...effect } of trigger.effects) {
    const effects = effectsByShape.get(shape) ?? []
    effects.push({ ...effect, startMs: now + effect.startMs })
    effectsByShape.set(shape, effects)
  }
  for (const [shape, incoming] of effectsByShape) {
    incoming.sort((a, b) => a.startMs - b.startMs)
    const target = layers.find(layer => layer.shape === shape)
    const first = incoming[0]
    if (target && first.to.opacity === 0 && first.from.opacity > 0) {
      first.from = slideActorAt(target, previous, first.startMs).value
    }
    const old = (actors[shape] ?? []).filter(effect => effect.startMs < incoming[0].startMs)
    // Keep the last started effect and any still-scheduled effects before the new chain.
    const firstFuture = old.findIndex(effect => effect.startMs > now)
    actors[shape] = [...(firstFuture < 0 ? old.slice(-1) : old.slice(Math.max(0, firstFuture - 1))), ...incoming]
  }
  return { runs: { ...previous?.runs, [trigger.id]: now }, actors }
}
