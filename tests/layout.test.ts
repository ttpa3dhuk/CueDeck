import { describe, expect, it } from 'vitest'
import { autoAssignDisplays, defaultLayoutForDisplayCount, rolesForLayout } from '../src/main/layout'

describe('rolesForLayout', () => {
  it('solo → только оператор', () => {
    expect(rolesForLayout('solo')).toEqual(['operator'])
  })

  it('presenter-audience → оператор + зал', () => {
    expect(rolesForLayout('presenter-audience')).toEqual(['operator', 'audience'])
  })

  it('operator-speaker-audience → все три роли', () => {
    expect(rolesForLayout('operator-speaker-audience')).toEqual(['operator', 'speaker', 'audience'])
  })
})

describe('defaultLayoutForDisplayCount', () => {
  it('0–1 экран → solo', () => {
    expect(defaultLayoutForDisplayCount(0)).toBe('solo')
    expect(defaultLayoutForDisplayCount(1)).toBe('solo')
  })

  it('2 экрана → presenter-audience', () => {
    expect(defaultLayoutForDisplayCount(2)).toBe('presenter-audience')
  })

  it('3+ экранов → operator-speaker-audience', () => {
    expect(defaultLayoutForDisplayCount(3)).toBe('operator-speaker-audience')
    expect(defaultLayoutForDisplayCount(5)).toBe('operator-speaker-audience')
  })
})

describe('autoAssignDisplays', () => {
  const internal = { id: 1, internal: true }
  const ext1 = { id: 2, internal: false }
  const ext2 = { id: 3, internal: false }

  it('оператор всегда на встроенном экране', () => {
    expect(autoAssignDisplays('solo', [internal, ext1])).toEqual({ operator: 1 })
  })

  it('2 экрана: зал на внешний', () => {
    expect(autoAssignDisplays('presenter-audience', [internal, ext1])).toEqual({
      operator: 1,
      audience: 2,
    })
  })

  it('2-экранная раскладка без внешнего: зал падает на встроенный', () => {
    expect(autoAssignDisplays('presenter-audience', [internal])).toEqual({
      operator: 1,
      audience: 1,
    })
  })

  it('3 экрана: суфлёр на первый внешний, зал на второй', () => {
    expect(autoAssignDisplays('operator-speaker-audience', [internal, ext1, ext2])).toEqual({
      operator: 1,
      speaker: 2,
      audience: 3,
    })
  })

  it('3-экранная раскладка на двух экранах: суфлёр и зал делят внешний', () => {
    expect(autoAssignDisplays('operator-speaker-audience', [internal, ext1])).toEqual({
      operator: 1,
      speaker: 2,
      audience: 2,
    })
  })

  it('нет встроенного экрана — берётся первый в списке', () => {
    expect(autoAssignDisplays('presenter-audience', [ext1, ext2])).toEqual({
      operator: 2,
      audience: 3,
    })
  })
})
