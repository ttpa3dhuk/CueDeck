import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearGpuAudienceGuard,
  isGpuAudienceActive,
  setGpuAudienceGuard,
  stopGpuAudienceForNormalOutput,
} from '../src/main/gpu-audience-arbiter'

afterEach(() => {
  const leftover = { stop: vi.fn() }
  setGpuAudienceGuard(leftover)
  clearGpuAudienceGuard(leftover)
})

describe('GPU audience arbitration', () => {
  it('stops the experiment once and lets the normal output continue', () => {
    const guard = { stop: vi.fn() }
    setGpuAudienceGuard(guard)
    expect(isGpuAudienceActive()).toBe(true)
    expect(stopGpuAudienceForNormalOutput('stream')).toBe(true)
    expect(guard.stop).toHaveBeenCalledWith('stream')
    expect(isGpuAudienceActive()).toBe(false)
    expect(stopGpuAudienceForNormalOutput('stream')).toBe(false)
  })

  it('never propagates a GPU stop failure into the normal output path', () => {
    setGpuAudienceGuard({ stop: () => { throw new Error('boom') } })
    expect(() => stopGpuAudienceForNormalOutput('omt')).not.toThrow()
    expect(isGpuAudienceActive()).toBe(false)
  })
})
