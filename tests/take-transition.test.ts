import { describe, expect, it } from 'vitest'
import { DEFAULT_TAKE_FADE_MS, sanitizeTakeFadeMs } from '../src/shared/take-transition'

describe('Fade duration from persisted settings and IPC', () => {
  it('uses 300 ms for missing, nonnumeric and nonfinite values', () => {
    for (const value of [undefined, null, '500', NaN, Infinity, -Infinity]) {
      expect(sanitizeTakeFadeMs(value)).toBe(DEFAULT_TAKE_FADE_MS)
    }
  })
  it('bounds user input to 100–400 ms', () => {
    expect(sanitizeTakeFadeMs(-500)).toBe(100)
    expect(sanitizeTakeFadeMs(0)).toBe(100)
    expect(sanitizeTakeFadeMs(50)).toBe(100)
    expect(sanitizeTakeFadeMs(2000)).toBe(400)
    expect(sanitizeTakeFadeMs(5000)).toBe(400)
    expect(sanitizeTakeFadeMs(90000)).toBe(400)
  })
  it('keeps the chosen duration and rounds fractional milliseconds', () => {
    expect(sanitizeTakeFadeMs(350)).toBe(350)
    expect(sanitizeTakeFadeMs(300.6)).toBe(301)
  })
})
