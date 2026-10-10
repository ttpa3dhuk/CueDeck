import { describe, expect, it } from 'vitest'
import { DEFAULT_TAKE_FADE_MS, sanitizeTakeFadeMs } from '../src/shared/take-transition'

describe('Fade duration from persisted settings and IPC', () => {
  it('uses 300 ms for missing, nonnumeric and nonfinite values', () => {
    for (const value of [undefined, null, '500', NaN, Infinity, -Infinity]) {
      expect(sanitizeTakeFadeMs(value)).toBe(DEFAULT_TAKE_FADE_MS)
    }
  })
  it('bounds user input to 100–5000 ms', () => {
    expect(sanitizeTakeFadeMs(-500)).toBe(100)
    expect(sanitizeTakeFadeMs(0)).toBe(100)
    expect(sanitizeTakeFadeMs(90000)).toBe(5000)
  })
  it('keeps the chosen duration and rounds fractional milliseconds', () => {
    expect(sanitizeTakeFadeMs(1250)).toBe(1250)
    expect(sanitizeTakeFadeMs(300.6)).toBe(301)
  })
})
