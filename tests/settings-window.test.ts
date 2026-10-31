import { describe, expect, it } from 'vitest'
import { clampSettingsOffset } from '../src/renderer/presenter/settings-window'

describe('settings dialog bounds', () => {
  const base = { left: 120, top: 70, width: 760, height: 620 }
  const viewport = { width: 1000, height: 800 }

  it('keeps the entire dialog reachable while dragging beyond every edge', () => {
    expect(clampSettingsOffset({ x: -1000, y: -1000 }, base, viewport)).toEqual({ x: -112, y: -62 })
    expect(clampSettingsOffset({ x: 1000, y: 1000 }, base, viewport)).toEqual({ x: 112, y: 102 })
    expect(clampSettingsOffset({ x: 25, y: -10 }, base, viewport)).toEqual({ x: 25, y: -10 })
  })

  it('clamps a remembered position to a smaller viewport', () => {
    expect(clampSettingsOffset({ x: 112, y: 102 }, base, { width: 900, height: 700 })).toEqual({ x: 12, y: 2 })
  })
})
