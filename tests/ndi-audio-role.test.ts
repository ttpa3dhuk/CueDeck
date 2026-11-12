import { describe, expect, it } from 'vitest'
import type { AppState } from '../src/shared/types'
import { shouldMute } from '../src/renderer/shared/video'

function solo(state: string, audio = true, muted = false, blackout = false): AppState {
  return { layout: 'solo', video: { muted }, blackout,
    ndi: { programAudio: audio, outputs: { program: { state } } },
  } as AppState
}

describe('NDI audio ownership in solo', () => {
  it('uses the hidden audience and keeps the operator silent for NDI audio', () => {
    expect(shouldMute(solo('on'), 'audience')).toBe(false)
    expect(shouldMute(solo('on'), 'operator')).toBe(true)
  })
  it.each([solo('off'), solo('error'), solo('on', false)])('returns audio to the operator without an active NDI audio output', (s) => {
    expect(shouldMute(s, 'audience')).toBe(true)
    expect(shouldMute(s, 'operator')).toBe(false)
  })
  it('still respects mute and blackout on the network audio owner', () => {
    expect(shouldMute(solo('on', true, true), 'audience')).toBe(true)
    expect(shouldMute(solo('on', true, false, true), 'audience')).toBe(true)
  })
})
