import { describe, expect, it } from 'vitest'
import { LatestFrameRecovery, RestartBudget } from '../src/main/syphon-bridge-core'

describe('bounded helper restart budget', () => {
  it('backs off exponentially and then refuses forever', () => {
    const budget = new RestartBudget(4, 250, 2000)
    expect(budget.nextDelayMs()).toBe(250)
    expect(budget.nextDelayMs()).toBe(500)
    expect(budget.nextDelayMs()).toBe(1000)
    expect(budget.nextDelayMs()).toBe(2000)
    expect(budget.nextDelayMs()).toBeNull()
    expect(budget.nextDelayMs()).toBeNull()
  })

  it('resets only when the helper has been stable', () => {
    const budget = new RestartBudget(2, 100, 1000)
    expect(budget.nextDelayMs()).toBe(100)
    expect(budget.nextDelayMs()).toBe(200)
    expect(budget.nextDelayMs()).toBeNull()
    budget.reset()
    expect(budget.used).toBe(0)
    expect(budget.nextDelayMs()).toBe(100)
  })
})

describe('bounded latest-state recovery', () => {
  it('requests exactly one fresh frame after a final change skipped while busy', () => {
    const recovery = new LatestFrameRecovery()
    let sends = 0
    let invalidates = 0
    const send = (): void => {
      sends++
      recovery.begin()
    }
    const ackPublished = (): void => {
      if (recovery.published()) invalidates++
    }

    send() // first frame is in flight
    recovery.skippedWhileBusy() // final static change arrives while helper is busy
    ackPublished()
    expect(invalidates).toBe(1) // bridge must request a fresh composed frame

    send() // exactly that fresh frame is sent
    ackPublished()
    expect(invalidates).toBe(1) // no continuous invalidate loop on unchanged frames
    expect(sends).toBe(2)
  })

  it('does not request a frame when nothing changed while busy or after a failure', () => {
    const recovery = new LatestFrameRecovery()
    recovery.begin()
    expect(recovery.published()).toBe(false)

    recovery.begin()
    recovery.skippedWhileBusy()
    recovery.reset() // timeout/restart path
    expect(recovery.published()).toBe(false)
  })
})
