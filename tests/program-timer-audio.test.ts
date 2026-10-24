import { describe, expect, it } from 'vitest'
import { TimerCueTracker } from '../src/renderer/shared/program-timer-audio'
import { createAudienceTimer } from '../src/shared/audience-timer'
import { createAudienceTimerCommands } from '../src/main/audience-timer'

const timer = () => ({ ...createAudienceTimer({ durationMs: 12_000, tickEnabled: true, gongEnabled: true }), running: true, startedAt: 0 })

describe('hall timer program cues', () => {
  it('ticks only the final ten seconds and emits one gong at zero', () => {
    const tracker = new TimerCueTracker(), t = timer()
    expect(tracker.update(t, 0)).toEqual([])
    expect(tracker.update(t, 1000)).toEqual([])
    expect(tracker.update(t, 2000)).toEqual(['tick'])
    expect(tracker.update(t, 2050)).toEqual([])
    expect(tracker.update(t, 11_000)).toEqual(['tick'])
    expect(tracker.update(t, 12_000)).toEqual(['gong'])
    expect(tracker.update(t, 13_000)).toEqual([])
  })
  it('handles loop wrap before and after seeing zero without a double gong', () => {
    const t = timer(), tracker = new TimerCueTracker()
    tracker.update(t, 11000)
    expect(tracker.update({ ...t, startedAt: 12000, cycles: 1 }, 12050)).toEqual(['gong'])
    expect(tracker.update({ ...t, startedAt: 12000, cycles: 1 }, 24000)).toEqual(['gong'])
    expect(tracker.update({ ...t, startedAt: 24000, cycles: 2 }, 24050)).toEqual([])
  })
  it('does not replay expired countdowns on window creation or ring in clock/stopwatch mode', () => {
    for (const mode of ['clock', 'stopwatch', 'countdown'] as const) {
      const tracker = new TimerCueTracker(), t = { ...timer(), mode }
      expect(tracker.update(t, 13000)).toEqual([])
      expect(tracker.update(t, 14000)).toEqual([])
    }
  })
  it('loops the hall independently, retaining elapsed remainder after a delayed main tick', () => {
    let audienceTimer = { ...timer(), loop: true }
    const store = { get: () => ({ audienceTimer }), patch: (patch: { audienceTimer?: typeof audienceTimer }) => {
      if (patch.audienceTimer) audienceTimer = patch.audienceTimer
    } }
    const commands = createAudienceTimerCommands(store as never, () => undefined)
    commands.tick(25000)
    expect(audienceTimer.cycles).toBe(2)
    expect(audienceTimer.elapsedMs).toBe(1000)
    expect(audienceTimer.startedAt).toBe(25000)
    commands.configure({ mode: 'stopwatch' })
    commands.tick(50000)
    expect(audienceTimer.cycles).toBe(2)
  })
})
