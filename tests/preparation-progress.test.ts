import { expect, it } from 'vitest'
import { PreparationProgress } from '../src/renderer/shared/preparation-progress'
import type { AppState } from '../src/shared/types'

it('counts a batch and disappears once it finishes, excluding old ready files', () => {
  const progress = new PreparationProgress()
  const states: AppState['preparations'] = { old: { phase: 'ready' } }
  expect(progress.update(states)).toBeNull()
  for (const path of ['a', 'b', 'c', 'd', 'e']) states[path] = { phase: 'queued' }
  expect(progress.update(states)).toEqual({ ready: 0, total: 5 })
  states.a = { phase: 'ready' }
  expect(progress.update(states)).toEqual({ ready: 1, total: 5 })
  for (const path of ['b', 'c', 'd', 'e']) states[path] = { phase: 'ready' }
  expect(progress.update(states)).toBeNull()
  states.f = { phase: 'preparing' }
  expect(progress.update(states)).toEqual({ ready: 0, total: 1 })
})

it('handles additions, retries, errors and removal without leaving a stuck counter', () => {
  const progress = new PreparationProgress()
  const states: AppState['preparations'] = { a: { phase: 'preparing' } }
  expect(progress.update(states)).toEqual({ ready: 0, total: 1 })
  states.b = { phase: 'queued' }
  expect(progress.update(states)).toEqual({ ready: 0, total: 2 })
  states.a = { phase: 'error' }
  expect(progress.update(states)).toEqual({ ready: 0, total: 2 })
  delete states.b
  expect(progress.update(states)).toBeNull()
  states.a = { phase: 'queued' }
  expect(progress.update(states)).toEqual({ ready: 0, total: 1 })
  expect(progress.update({})).toBeNull()
})
