import { describe, expect, it } from 'vitest'
import { GPU_PIXEL_BGRA, GPU_PIXEL_RGBA, GpuSendGate } from '../src/main/syphon-gpu-core'

describe('GPU send gate', () => {
  it('allows one texture at a time and recovers only after ack', () => {
    const gate = new GpuSendGate()
    expect(gate.begin()).toBe(false)
    gate.markReady()
    expect(gate.begin()).toBe(true)
    expect(gate.begin()).toBe(false)
    expect(gate.isInFlight()).toBe(true)
    gate.ack()
    expect(gate.begin()).toBe(true)
    gate.markDead()
    expect(gate.begin()).toBe(false)
  })

  it('keeps pixel-format codes explicit', () => {
    expect(GPU_PIXEL_BGRA).toBe(1)
    expect(GPU_PIXEL_RGBA).toBe(2)
    expect(GPU_PIXEL_BGRA).not.toBe(GPU_PIXEL_RGBA)
  })
})
