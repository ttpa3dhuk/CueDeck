import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { createAudienceTimerCommands } from '../src/main/audience-timer'
import { audienceTimerConfig, createAudienceTimer } from '../src/shared/audience-timer'
import { elapsedMs, remainingMs, timerView } from '../src/renderer/shared/timer'
import { loadProjectFile, saveProjectFile } from '../src/main/project'
import { timerAdjustments } from '../src/shared/timer-controls'
import { transferProject } from '../src/main/project-transfer'

afterEach(() => vi.useRealTimers())

describe('independent audience countdown', () => {
  it('mirrors hall switches for legacy remote/profile feedback without changing the speaker clock', () => {
    const store = new StateStore()
    const speaker = store.get().timer
    const commands = createAudienceTimerCommands(store, vi.fn())
    commands.configure({ loop: true, tickEnabled: true, gongEnabled: true })
    expect(store.get().timerLoop).toBe(true)
    expect(store.get().timerTickEnabled).toBe(true)
    expect(store.get().timerGongEnabled).toBe(true)
    expect(store.get().timer).toBe(speaker)
    commands.configure({ loop: false })
    expect(store.get().timerLoop).toBe(false)
  })

  it('starts, pauses, resumes and resets without changing the running speaker clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const store = new StateStore()
    store.patchTimer({ running: true, startedAt: 500, elapsedMs: 300 })
    const speaker = store.get().timer
    const commands = createAudienceTimerCommands(store, vi.fn())
    commands.action('start')
    expect(store.get().audienceTimer.visible).toBe(true)
    vi.advanceTimersByTime(10_000)
    commands.action('pause')
    expect(elapsedMs(store.get().audienceTimer)).toBe(10_000)
    expect(elapsedMs(speaker)).toBe(10_800)
    vi.advanceTimersByTime(5_000)
    commands.action('start')
    commands.setVisible(false)
    vi.advanceTimersByTime(2000)
    store.patch({ currentSlide: 2 })
    expect(elapsedMs(store.get().audienceTimer)).toBe(12_000)
    expect(store.get().audienceTimer.visible).toBe(false)
    commands.action('reset')
    expect(remainingMs(store.get().audienceTimer)).toBe(5 * 60_000)
    expect(store.get().timer).toBe(speaker)
    expect(elapsedMs(speaker)).toBe(17_800)
  })

  it('supports countdown, stopwatch and wall clock independently, including persisted modes', () => {
    const store = new StateStore()
    const commands = createAudienceTimerCommands(store, vi.fn())
    const speaker = store.get().timer
    commands.configure({ mode: 'stopwatch' })
    expect(timerView(store.get().audienceTimer, store.get().audienceTimer.mode, 1000).text).toBe('00:00')
    commands.configure({ mode: 'clock' })
    const now = new Date(2026, 9, 22, 13, 14, 15).getTime()
    expect(timerView(store.get().audienceTimer, store.get().audienceTimer.mode, now).text).toBe('13:14:15')
    expect(createAudienceTimer(audienceTimerConfig(store.get().audienceTimer)).mode).toBe('clock')
    commands.configure({ mode: 'invalid' })
    expect(store.get().audienceTimer.mode).toBe('countdown')
    expect(createAudienceTimer({ durationMs: 90_000 }).mode).toBe('countdown')
    expect(store.get().timer).toBe(speaker)
  })

  it('keeps two subtract and two add controls editable with validated magnitudes', () => {
    expect(timerAdjustments(undefined)).toEqual([-5, -1, 1, 5])
    expect(timerAdjustments([-7, 2, -3, 9])).toEqual([-7, -2, 3, 9])
    expect(timerAdjustments([0, Infinity, NaN, 1000])).toEqual([-5, -1, 1, 5])
  })

  it('configuration cannot overwrite live clocks, and persists only appearance and duration', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const store = new StateStore()
    const persist = vi.fn()
    const commands = createAudienceTimerCommands(store, persist)
    commands.action('start')
    vi.advanceTimersByTime(2000)
    commands.configure({ durationMs: 20_000, color: '#ff0011', running: false, elapsedMs: 123456, visible: false })
    expect(store.get().audienceTimer.running).toBe(true)
    expect(store.get().audienceTimer.visible).toBe(true)
    expect(remainingMs(store.get().audienceTimer)).toBe(18_000)
    expect(persist.mock.calls[0][0]).not.toHaveProperty('running')
    expect(persist.mock.calls[0][0]).not.toHaveProperty('visible')
    expect(persist.mock.calls[0][0].color).toBe('#ff0011')
    commands.configure(null)
    commands.configure([])
    commands.setVisible('yes')
    expect(persist).toHaveBeenCalledTimes(1)
    expect(store.get().audienceTimer.visible).toBe(true)
  })

  it('sanitizes imported configuration and never restores a running/visible timer', () => {
    const restored = createAudienceTimer({
      durationMs: Infinity, color: 'url(example)', scale: 100,
      position: { x: -1, y: 2 }, running: true, startedAt: 10, visible: true,
    })
    expect(restored.durationMs).toBe(300_000)
    expect(restored.color).toBe('#ffffff')
    expect(restored.backgroundOpacity).toBe(0.8)
    expect(audienceTimerConfig({ backgroundOpacity: -1 }).backgroundOpacity).toBe(0)
    expect(audienceTimerConfig({ backgroundOpacity: 2 }).backgroundOpacity).toBe(1)
    expect(restored.position).toEqual({ x: 0, y: 1 })
    expect(restored.scale).toBe(3)
    expect(restored.running).toBe(false)
    expect(restored.visible).toBe(false)
    expect(restored.startedAt).toBeNull()
  })

  it('preserves configuration through project save/load and flash-drive transfer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cuedeck-audience-timer-'))
    try {
      const timer = { ...createAudienceTimer({ durationMs: 90_000, color: '#123456', position: { x: 0.2, y: 0.3 }, font: 'serif', backgroundOpacity: 0.35 }), running: true, visible: true }
      const config = audienceTimerConfig(timer)
      const project = join(directory, 'timer.pdpres')
      await saveProjectFile(project, { playlist: [], keyVisualPath: null, audienceTimer: timer })
      const raw = JSON.parse(await readFile(project, 'utf8'))
      expect(raw.audienceTimer).toEqual(config)
      expect((await loadProjectFile(project)).audienceTimer).toEqual(config)
      const exported = await transferProject({ parent: directory, name: 'show', playlist: [], keyVisualPath: null,
        audienceTimer: config, prepare: async () => [], progress: vi.fn() })
      const loaded = await loadProjectFile(exported.path)
      expect(loaded.audienceTimer).toEqual(config)
      expect(createAudienceTimer(loaded.audienceTimer).visible).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
