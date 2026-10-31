import { describe, expect, it } from 'vitest'
import { timerFont, timerFontCss } from '../src/shared/timer-font'
import { audienceTimerConfig, createAudienceTimer } from '../src/shared/audience-timer'

describe('timer font configuration', () => {
  it('preserves named families and legacy defaults through configuration round trips', () => {
    for (const font of ['system', 'mono', 'serif', 'Arial', 'PT Sans', 'Шрифт мероприятия']) {
      const config = audienceTimerConfig({ font })
      expect(createAudienceTimer(JSON.parse(JSON.stringify(config))).font).toBe(font)
    }
    expect(audienceTimerConfig({}).font).toBe('mono')
    expect(timerFont(undefined)).toBe('system')
    for (const value of [null, 42, {}, '', ' ', 'a\nb', 'x'.repeat(201)]) expect(timerFont(value)).toBe('system')
  })
  it('quotes family names as one CSS family, including quotes, commas and backslashes', () => {
    expect(timerFontCss('Arial')).toBe('"Arial", system-ui, sans-serif')
    expect(timerFontCss('A, B')).toBe('"A, B", system-ui, sans-serif')
    expect(timerFontCss('A"B\\C')).toBe('"A\\"B\\\\C", system-ui, sans-serif')
    expect(timerFontCss('mono')).toContain('monospace')
  })
})
