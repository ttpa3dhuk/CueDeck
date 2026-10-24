import { describe, expect, it } from 'vitest'
import { createAudienceTimer } from '../src/shared/audience-timer'
import { createAudienceTimerCommands } from '../src/main/audience-timer'
import { resolveRemote, type RemoteStateView } from '../src/main/remote/commands'
import { audienceTimerStatus, companionOfflineVars, companionVars, type CompanionStateView } from '../src/main/remote/companion-vars'

const hall = () => createAudienceTimer({ durationMs: 90_000, loop: true, tickEnabled: true, gongEnabled: true })
const state = (): CompanionStateView => ({
  audienceTimer: hall(),
  timer: { durationMs: 600_000, elapsedMs: 0, startedAt: null, running: false, cycles: 0 },
  timerMode: 'countdown', timerPosition: 'top-right', timerPresets: [5, 10, 15], speakerMsgPresets: [],
  fileKind: null, pdfPath: null, slideMedia: [], currentSlide: 0, totalSlides: 0, blackout: false,
  video: { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: false },
  videoLoop: false, playlist: [], currentPlaylistId: null, speakerMessage: null,
  preview: { path: null } as RemoteStateView['preview'],
  stream: { running: false, destinations: [] } as unknown as RemoteStateView['stream'],
  omt: { outputs: { program: { state: 'off', receivers: 0 } } } as unknown as RemoteStateView['omt'],
  timerLoop: true, timerTickEnabled: true, timerGongEnabled: true,
})
const resolve = (route: string, s = state(), args: (string | number | boolean)[] = []) => resolveRemote(route.split('/'), args, s)

describe('independent hall timer remote controls', () => {
  it('executes start, pause, reset, duration, mode and visibility without mutating the speaker', () => {
    let s = state()
    const speaker = structuredClone(s.timer)
    const commands = createAudienceTimerCommands({ get: () => s, patch: (patch: Partial<typeof s>) => { s = { ...s, ...patch } } } as never, () => undefined)
    const execute = (route: string) => {
      const result = resolve(route, s)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error)
      for (const call of result.calls) {
        switch (call.channel) {
          case 'audience-timer:start': commands.action('start'); break
          case 'audience-timer:pause': commands.action('pause'); break
          case 'audience-timer:reset': commands.action('reset'); break
          case 'audience-timer:configure': commands.configure(call.args[0]); break
          case 'audience-timer:visible': commands.setVisible(call.args[0]); break
          default: throw new Error(`Unexpected channel ${call.channel}`)
        }
      }
      expect(s.timer).toEqual(speaker)
    }
    execute('audience-timer/toggle')
    expect(s.audienceTimer).toMatchObject({ running: true, visible: true })
    execute('audience-timer/visible/off')
    expect(s.audienceTimer).toMatchObject({ running: true, visible: false })
    execute('audience-timer/toggle')
    expect(s.audienceTimer.running).toBe(false)
    execute('audience-timer/restart')
    expect(s.audienceTimer).toMatchObject({ running: true, visible: true, elapsedMs: 0 })
    execute('audience-timer/set/2:30')
    expect(s.audienceTimer).toMatchObject({ durationMs: 150_000, running: false, elapsedMs: 0, cycles: 0 })
    execute('audience-timer/mode/stopwatch')
    expect(s.audienceTimer.mode).toBe('stopwatch')
    execute('audience-timer/reset')
    expect(s.audienceTimer).toMatchObject({ mode: 'stopwatch', elapsedMs: 0, running: false })
  })

  it.each([['loop', 'loop'], ['tick', 'tickEnabled'], ['gong', 'gongEnabled']] as const)('%s has idempotent on/off and toggle with OSC release ignored', (route, field) => {
    expect(resolve(`audience-timer/${route}/on`)).toMatchObject({ ok: true, calls: [] })
    expect(resolve(`audience-timer/${route}/off`)).toMatchObject({ ok: true, calls: [{ channel: 'audience-timer:configure', args: [{ [field]: false }] }] })
    expect(resolve(`audience-timer/${route}`)).toEqual(resolve(`audience-timer/${route}/toggle`))
    expect(resolve(`audience-timer/${route}/toggle`, state(), [0])).toMatchObject({ ok: true, ignored: true, calls: [] })
  })

  it('validates hall duration before dispatch instead of silently clamping to 24 hours', () => {
    for (const bad of ['25h', '-1', 'oops', '1000h']) expect(resolve(`audience-timer/set/${bad}`)).toMatchObject({ ok: false })
    for (const value of ['0', '24h', '1:30', '90s']) expect(resolve(`audience-timer/set/${value}`).ok).toBe(true)
    expect(resolve('audience-timer/set/5')).toEqual(resolve('audience-timer/set', state(), [5]))
    expect(resolve('audience-timer/mode/unknown')).toMatchObject({ ok: false })
    expect(resolve('timer/start')).toMatchObject({ ok: true, calls: [{ channel: 'timer:start', args: [] }] })
  })

  it('adjusts a running hidden hall clock without resetting it or changing the speaker', () => {
    let s = state()
    s.audienceTimer = { ...hall(), startedAt: 1000, elapsedMs: 10_000, running: true, visible: false }
    const speaker = s.timer
    const commands = createAudienceTimerCommands({get:()=>s,patch:(p:Partial<typeof s>)=>{s={...s,...p}}} as never,()=>undefined)
    for (const [route, delta] of [['audience-timer/add/1',60_000],['audience-timer/sub/30s',-30_000]] as const) {
      expect(resolve(route,s)).toMatchObject({ok:true,calls:[{channel:'audience-timer:adjust',args:[delta]}]})
      commands.adjust(delta,31_000)
    }
    expect(s.audienceTimer).toMatchObject({durationMs:120_000,startedAt:1000,elapsedMs:10_000,running:true,visible:false})
    expect(s.timer).toBe(speaker)
    commands.configure({mode:'stopwatch'})
    commands.adjust(-60_000,31_000)
    expect(s.audienceTimer).toMatchObject({elapsedMs:0,startedAt:31_000,running:true})
    commands.adjust(60_000,31_000)
    expect(s.audienceTimer.elapsedMs).toBe(60_000)
    commands.configure({mode:'clock'})
    const clock=s.audienceTimer
    commands.adjust(60_000,31_000)
    expect(s.audienceTimer).toBe(clock)
    for(const value of ['-1','no','25h']) expect(resolve('audience-timer/add/'+value,s).ok).toBe(false)
  })

  it('projects the hall clock independently to HTTP state and Companion variables', () => {
    const s = state()
    s.audienceTimer = { ...hall(), startedAt: 1000, running: true, visible: false }
    expect(audienceTimerStatus(s.audienceTimer, 92_000)).toEqual({
      text: '−00:01', color: 'red', overtime: true, running: true, visible: false, mode: 'countdown',
      durationMs: 90_000, durationText: '01:30', elapsedMs: 91_000, remainingMs: -1000,
      loop: true, tickEnabled: true, gongEnabled: true,
    })
    const vars = companionVars(s, 92_000, 0)
    expect(vars).toMatchObject({ cuedeck_timer: '10:00', cuedeck_timer_running: '0',
      cuedeck_audience_timer: '−00:01', cuedeck_audience_timer_color: 'red', cuedeck_audience_timer_over: '1',
      cuedeck_audience_timer_running: '1', cuedeck_audience_timer_visible: '0', cuedeck_audience_timer_mode: 'countdown',
      cuedeck_audience_timer_loop: '1', cuedeck_audience_timer_tick: '1', cuedeck_audience_timer_gong: '1' })
    s.audienceTimer.mode = 'stopwatch'
    expect(audienceTimerStatus(s.audienceTimer, 92_000)).toMatchObject({ text: '01:31', overtime: false })
    expect(companionOfflineVars()).toMatchObject({ cuedeck_audience_timer: '', cuedeck_audience_timer_running: '0', cuedeck_audience_timer_visible: '0' })
  })
})
