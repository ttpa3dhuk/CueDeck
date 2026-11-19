import { describe, expect, it } from 'vitest'
import type { SlideInteractiveLayer, SlideTrigger } from '../src/shared/types'
import { slideActorAt, startSlideTrigger } from '../src/shared/slide-triggers'

const rect = { x: 0, y: 0, w: 1, h: 1 }
const layers: SlideInteractiveLayer[] = ['1', '2', '3'].map((shape, i) => ({
  page: i * 2 + 2, shape, rect, initiallyHidden: true,
}))

function effect(shape: string, startMs: number, durationMs: number, enter = true) {
  return { shape, startMs, durationMs, from: { x: 0, y: 0, opacity: Number(!enter) },
    to: { x: 0, y: 0, opacity: Number(enter) } }
}

const a: SlideTrigger = {
  id: 'a', shape: '4', rect, label: 'A', restart: 'whenNotActive', durationMs: 750,
  effects: [effect('1', 0, 250), effect('2', 500, 250)],
}
const b: SlideTrigger = {
  id: 'b', shape: '5', rect, label: 'B', restart: 'never', durationMs: 400,
  effects: [effect('3', 0, 400)],
}

describe('interactive slide timeline', () => {
  it('keeps independent timelines and applies the authored restart rules', () => {
    const first = startSlideTrigger(a, layers, undefined, 100)!
    expect(startSlideTrigger(a, layers, first, 400)).toBeNull()
    const combined = startSlideTrigger(b, layers, first, 400)!
    expect(slideActorAt(layers[0], combined, 500).value.opacity).toBe(1)
    expect(slideActorAt(layers[1], combined, 500).value.opacity).toBe(0)
    expect(slideActorAt(layers[2], combined, 500).value.opacity).toBe(.25)
    expect(startSlideTrigger(b, layers, combined, 950)).toBeNull()
    const replay = startSlideTrigger(a, layers, combined, 950)!
    expect(slideActorAt(layers[1], replay, 1000).value.opacity).toBe(1)
    expect(slideActorAt(layers[1], replay, 1500).value.opacity).toBe(.2)
    expect(replay.runs).toEqual({ a: 950, b: 400 })
  })

  it('cancels pending effects on targets reset by a subsequent click without flashing hidden layers', () => {
    const initial = startSlideTrigger(a, layers, undefined, 100)!
    const reset: SlideTrigger = {
      id: 'reset', shape: '6', rect, label: 'Reset', restart: 'always', durationMs: 200,
      effects: [effect('1', 0, 200, false), effect('2', 0, 200, false)],
    }
    const cleared = startSlideTrigger(reset, layers, initial, 225)!
    expect(slideActorAt(layers[0], cleared, 225).value.opacity).toBe(.5)
    expect(slideActorAt(layers[1], cleared, 225).value.opacity).toBe(0)
    expect(slideActorAt(layers[1], cleared, 750).value.opacity).toBe(0)
    expect(startSlideTrigger({ ...b, shape: '2' }, layers, cleared, 750)).toBeNull()
  })
})
