import { describe, expect, it } from 'vitest'
import { sanitizeSpeakerToolbarScale } from '../src/shared/prompter-toolbar'
import { GROUP_KEYS, sanitizeSettings, mergeSettings } from '../src/main/profile-core'

describe('prompter toolbar scale', () => {
  it('opens old settings at 100% and rejects invalid values', () => {
    for (const value of [undefined, null, '3', NaN, Infinity, {}, []]) {
      expect(sanitizeSpeakerToolbarScale(value)).toBe(1)
    }
    expect(sanitizeSettings({}).speakerToolbarScale).toBe(1)
  })
  it('bounds to 100–400% and uses 10% steps', () => {
    expect(sanitizeSpeakerToolbarScale(-5)).toBe(1)
    expect(sanitizeSpeakerToolbarScale(99)).toBe(4)
    expect(sanitizeSpeakerToolbarScale(2.53)).toBe(2.5)
  })
  it('belongs to the prompter venue profile group', () => {
    expect(GROUP_KEYS.prompter).toContain('speakerToolbarScale')
    const current = sanitizeSettings({ speakerToolbarScale: 1.5 })
    const saved = sanitizeSettings({ speakerToolbarScale: 3 })
    expect(mergeSettings(current, saved, ['prompter']).speakerToolbarScale).toBe(3)
    expect(mergeSettings(current, saved, ['audio']).speakerToolbarScale).toBe(1.5)
  })
})
