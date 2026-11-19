import { afterEach, expect, it, vi } from 'vitest'
import { PptxAudioOutput } from '../src/renderer/shared/pptx-audio-output'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function fixture() {
  vi.useFakeTimers()
  const gain = {
    gain: { value: 1, cancelAndHoldAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(),
  }
  const source = { connect: vi.fn(() => gain), disconnect: vi.fn() }
  const context = {
    currentTime: 2, destination: {}, createGain: vi.fn(() => gain), setSinkId: vi.fn(async () => {}),
    createMediaElementSource: vi.fn(() => source), resume: vi.fn(async () => {}),
  }
  vi.stubGlobal('AudioContext', vi.fn(function () { return context }))
  const element = {
    crossOrigin: 'anonymous', paused: false, ended: false, seeking: false, readyState: 3,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }
  return { output: new PptxAudioOutput(), element: element as unknown as HTMLMediaElement, gain, source, context }
}

it('ramps a PPTX source before switching it and leaves the default device open', () => {
  const { output, element, gain, context } = fixture()
  const switchSource = vi.fn()
  expect(output.configure(element, false, null)).toBe(true)
  expect(gain.gain.value).toBe(0)
  expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 2.018)
  expect(context.setSinkId).not.toHaveBeenCalled()
  expect(output.holdForSwitch(element, switchSource)).toBe(true)
  expect(output.holdForSwitch(element, switchSource)).toBe(true)
  expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 2.018)
  vi.advanceTimersByTime(18)
  expect(switchSource).not.toHaveBeenCalled()
  vi.advanceTimersByTime(5)
  expect(switchSource).toHaveBeenCalledOnce()
  expect(output.holdForSwitch(element, switchSource)).toBe(false)
})

it('keeps an outgoing cue alive until the ramp finishes, then disconnects it', () => {
  const { output, element, source, gain } = fixture()
  const dispose = vi.fn()
  output.configure(element, false, null)
  output.retire(element, dispose)
  expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 2.018)
  expect(dispose).not.toHaveBeenCalled()
  vi.advanceTimersByTime(23)
  expect(dispose).toHaveBeenCalledOnce()
  expect(source.disconnect).toHaveBeenCalledOnce()
  expect(output.has(element)).toBe(false)
})
