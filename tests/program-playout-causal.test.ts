import type { NativeImage } from 'electron'
import { expect, it } from 'vitest'
import { ProgramVideoTimeline } from '../src/main/program-playout'

const frame = (id: number): NativeImage => ({
  id, isEmpty: () => false, getSize: () => ({ width: 32, height: 18 }),
}) as unknown as NativeImage

/** Measured tap and free-slot times relative to the first white tap in the 59a5 causal run. */
interface CausalCase {
  name: string
  seed: [number, number, number]
  taps: Array<[number, number]>
  intermediate?: number
  slot: number
  expected: number
}
const cases: CausalCase[] = [
  { name: 'NDI 5080', seed: [5079, -42, 52], taps: [[5080, 0], [5081, 25], [5082, 43], [5083, 83]], slot: 168, expected: 5081 },
  { name: 'NDI 6344', seed: [6342, -73, 42], taps: [[6343, -18], [6344, 0], [6345, 8], [6346, 39], [6347, 65]], slot: 167, expected: 6344 },
  { name: 'NDI 7786', seed: [7783, -73, 7], taps: [[7784, -50], [7785, -7], [7786, 0], [7787, 54], [7788, 97], [7789, 110], [7790, 142]],
    intermediate: 119, slot: 224, expected: 7787 },
  { name: 'OMT 3758', seed: [3757, -5, 76], taps: [[3758, 0], [3759, 65], [3760, 113], [3761, 123]], slot: 207, expected: 3759 },
  { name: 'OMT 6344', seed: [6343, -18, 73], taps: [[6344, 0], [6345, 8], [6346, 39], [6347, 65]], slot: 188, expected: 6345 },
]

it.each(cases)('keeps the measured $name white frame within 200 ms on a delayed free slot', ({ seed, taps, intermediate, slot, expected }) => {
  const timeline = new ProgramVideoTimeline(), cursor = timeline.consumer()
  const captures = [[seed[0], seed[1]], ...taps].sort((a, b) => a[1] - b[1])
  let next = 0
  const advance = (at: number): void => {
    while (next < captures.length && captures[next][1] <= at) {
      timeline.push(frame(captures[next][0]), captures[next][1])
      next++
    }
  }
  advance(seed[2])
  expect((cursor.next(30, seed[2])?.image as any).id).toBe(seed[0])
  if (intermediate !== undefined) {
    advance(intermediate)
    expect((cursor.next(30, intermediate)?.image as any).id).toBe(7785)
  }
  advance(slot)
  expect((cursor.next(30, slot)?.image as any).id).toBe(expected)
})
