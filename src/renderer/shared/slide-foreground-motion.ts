import type { SlideForegroundActor, SlideForegroundMotion, SlideForegroundStep } from '../../shared/types'

export interface RasterMotion {
  base: HTMLCanvasElement
  actors: Array<{ source: HTMLCanvasElement; motion: SlideForegroundActor }>
  duration: number
  repeating: boolean
}

export function rasterMotion(base: HTMLCanvasElement, sources: HTMLCanvasElement[], motion: SlideForegroundMotion): RasterMotion {
  const steps = motion.actors.flatMap(actor => [actor, ...(actor.following ?? [])])
  return { base, actors: motion.actors.map((actor, index) => ({ motion: actor, source: sources[index] })),
    duration: Math.max(...steps.map(step => step.startMs + step.durationMs)),
    repeating: motion.actors.some(actor => Boolean((actor.following?.at(-1) ?? actor).rotations)) }
}

function mix(a: number, b: number, progress: number): number { return a + (b - a) * progress }

function rotationAt(actor: SlideForegroundStep, time: number): number {
  if (!actor.rotations?.length) return 0
  const local = time % actor.durationMs
  const next = actor.rotations.findIndex(point => point.timeMs > local)
  if (next < 1) return 0
  const a = actor.rotations[next - 1]
  const b = actor.rotations[next]
  return mix(a.degrees, b.degrees, (local - a.timeMs) / (b.timeMs - a.timeMs))
}

export function drawForegroundMotion(layer: HTMLCanvasElement, stage: RasterMotion, elapsed: number): void {
  const { width, height } = stage.base
  if (layer.width !== width || layer.height !== height) {
    layer.width = width
    layer.height = height
  }
  const ctx = layer.getContext('2d')!
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(stage.base, 0, 0)
  for (const { motion, source } of stage.actors) {
    let step: SlideForegroundStep = motion
    for (const next of motion.following ?? []) {
      if (next.startMs > elapsed) break
      step = next
    }
    const local = elapsed - step.startMs
    const progress = Math.max(0, Math.min(1, local / step.durationMs))
    const startingOffSlide = step.from.x !== step.to.x || step.from.y !== step.to.y
    // Delayed fly-in actors must stay invisible until their own build begins.
    const entering = step.from.opacity === 0 || (startingOffSlide && step.to.x === 0 && step.to.y === 0)
    if (local < 0 && entering) continue
    ctx.save()
    ctx.globalAlpha = mix(step.from.opacity, step.to.opacity, progress)
    const x = motion.pivot.x * width, y = motion.pivot.y * height
    ctx.translate(x + mix(step.from.x, step.to.x, progress) * width, y + mix(step.from.y, step.to.y, progress) * height)
    ctx.rotate(rotationAt(step, Math.max(0, local)) * Math.PI / 180)
    ctx.drawImage(source, motion.rect.x * width - x, motion.rect.y * height - y, motion.rect.w * width, motion.rect.h * height)
    ctx.restore()
  }
}

export function releaseForegroundMotion(stage?: RasterMotion): void {
  if (!stage) return
  for (const canvas of [stage.base, ...stage.actors.map(actor => actor.source)]) canvas.width = canvas.height = 0
}
