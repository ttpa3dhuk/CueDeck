import { describe, expect, it } from 'vitest'
import { safeDisplayLayout } from '../src/shared/display-safety'
const screens = [{ id: 1, internal: true }, { id: 2 }, { id: 3 }]
describe('operator display safety', () => {
  it('assigns a newly enabled audience to the external display', () => {
    expect(safeDisplayLayout('presenter-audience', { operator: 1 }, screens.slice(0, 2)))
      .toEqual({ layout: 'presenter-audience', displayMap: { operator: 1, audience: 2 } })
  })
  it('keeps an explicitly windowed prompter on the operator and repairs the audience', () => {
    const { displayMap } = safeDisplayLayout('operator-speaker-audience', { operator: 1, speaker: 1, audience: 1 }, screens)
    expect(displayMap).toEqual({ operator: 1, speaker: 1, audience: 2 })
  })
  it('preserves a valid audience assignment when enabling the prompter', () => {
    expect(safeDisplayLayout('operator-speaker-audience', { operator: 1, audience: 2 }, screens).displayMap)
      .toEqual({ operator: 1, speaker: 3, audience: 2 })
  })
  it('protects an operator manually placed on an external display', () => {
    const result = safeDisplayLayout('presenter-audience', { operator: 2, audience: 2 }, screens)
    expect(result.displayMap).toEqual({ operator: 2, audience: 1 })
  })
  it('falls back to solo for disconnected displays and a single remaining screen', () => {
    expect(safeDisplayLayout('operator-speaker-audience', { operator: 9, speaker: 8, audience: 7 }, screens.slice(0, 1)))
      .toEqual({ layout: 'solo', displayMap: { operator: 1 } })
  })
  it('allows a normal audience window on the operator screen', () => {
    expect(safeDisplayLayout('presenter-audience', { operator: 1, audience: 1 }, screens.slice(0, 1), true))
      .toEqual({ layout: 'presenter-audience', displayMap: { operator: 1, audience: 1 } })
  })
  it('shares the external display rather than covering the operator with three roles on two displays', () => {
    expect(safeDisplayLayout('operator-speaker-audience', { operator: 1 }, screens.slice(0, 2)).displayMap)
      .toEqual({ operator: 1, speaker: 2, audience: 2 })
  })
  it('keeps the windowed audience when three roles are requested on one display', () => {
    expect(safeDisplayLayout('operator-speaker-audience', { operator: 1, speaker: 2, audience: 2 }, screens.slice(0, 1), true))
      .toEqual({ layout: 'operator-speaker-audience', displayMap: { operator: 1, speaker: 1, audience: 1 } })
  })
  it('keeps all roles when the prompter has a separate display and the audience is windowed', () => {
    expect(safeDisplayLayout('operator-speaker-audience', { operator: 1, speaker: 2, audience: 1 }, screens.slice(0, 2), true))
      .toEqual({ layout: 'operator-speaker-audience', displayMap: { operator: 1, speaker: 2, audience: 1 } })
  })
})
