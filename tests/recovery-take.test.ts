import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { initialDeckState } from '../src/main/state'
import { recoveryTakeFrame } from '../src/shared/recovery-take'

describe('explicit forensic TAKE', () => {
  it('keeps page and video position paused/muted, and normal decks keep their ordinary policy', () => {
    const preview = { ...initialDeckState(), recoveryTake: true, kind: 'pptx' as const, currentSlide: 5, totalSlides: 20,
      video: { playing: true, anchorSec: 10, anchorAt: 1000, durationSec: 60, muted: false } }
    expect(recoveryTakeFrame(preview, 12.5)).toEqual({ slide: 5, video: { playing: false, anchorSec: 12.5, anchorAt: null, durationSec: 60, muted: true } })
    expect(recoveryTakeFrame({ ...preview, recoveryTake: false }, 12.5)).toBeNull()
    expect(recoveryTakeFrame(initialDeckState(), 0)).toBeNull()
  })
  it('bounds positions to the imported media without importing other runtime settings', () => {
    const preview = { ...initialDeckState(), recoveryTake: true, currentSlide: 50, totalSlides: 5,
      video: { playing: false, anchorAt: null, anchorSec: 0, muted: true, durationSec: 20 } }
    expect(recoveryTakeFrame(preview, 100)?.video.anchorSec).toBe(20)
    expect(recoveryTakeFrame(preview, Infinity)?.video.anchorSec).toBe(0)
    expect(recoveryTakeFrame(preview, 0)?.slide).toBe(5)
  })
})
