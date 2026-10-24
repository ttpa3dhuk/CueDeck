import type { AppState, Role } from '../../shared/types'
import type { AudienceTimerState } from '../../shared/audience-timer'
import { remainingMs } from './timer'
import { shouldMute } from './video'

export type TimerCue = 'tick' | 'gong'

/** Observe each window's clock even when muted, so changing outputs never replays a cue. */
export class TimerCueTracker {
  private cycles: number | null = null
  private second = -1
  private ended = false

  update(timer: AudienceTimerState, now = Date.now()): TimerCue[] {
    const remaining = remainingMs(timer, now)
    const second = Math.ceil(remaining / 1000)
    if (this.cycles === null) {
      this.cycles = timer.cycles
      this.second = second
      this.ended = remaining <= 0
      return []
    }
    const wrapped = timer.cycles > this.cycles
    const reset = timer.cycles < this.cycles
    this.cycles = timer.cycles
    const cues: TimerCue[] = []
    if (timer.mode !== 'countdown' || !timer.running) {
      this.second = second
      if (remaining > 0 || reset) this.ended = false
      return cues
    }
    if (wrapped) {
      if (!this.ended && timer.gongEnabled) cues.push('gong')
      this.ended = false
      this.second = -1
    }
    if (remaining > 0) this.ended = false
    if (remaining > 0 && second <= 10 && second !== this.second && timer.tickEnabled && !wrapped) cues.push('tick')
    if (remaining <= 0 && !this.ended) {
      this.ended = true
      if (timer.gongEnabled) cues.push('gong')
    }
    this.second = second
    return cues
  }
}

type RoutedContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

/** Same window and device as program media: included in program tab capture for OMT/RTMP. */
export class ProgramTimerAudio {
  private tracker = new TimerCueTracker()
  private context: RoutedContext | null = null
  private output: GainNode | null = null
  private sink: string | undefined
  private routed = false
  private revision = 0
  private routing: Promise<void> = Promise.resolve()
  private muted = true

  constructor(private role: Role) {}

  update(state: AppState): void {
    const cues = this.tracker.update(state.audienceTimer)
    this.muted = shouldMute(state, this.role)
    // Speaker windows never create an audio graph.
    if (this.role === 'speaker') return
    if (!this.context && !this.muted && (state.audienceTimer.tickEnabled || state.audienceTimer.gongEnabled)) {
      this.context = new AudioContext() as RoutedContext
      this.output = this.context.createGain()
      this.output.gain.value = 0
      this.output.connect(this.context.destination)
    }
    const context = this.context
    if (!context || !this.output) return
    const sink = state.audioOutputId ?? ''
    if (sink !== this.sink) {
      this.sink = sink
      this.routed = false
      const revision = ++this.revision
      this.routing = this.routing.then(async () => {
        if (revision !== this.revision) return
        if (context.setSinkId) await context.setSinkId(sink)
        else if (sink) throw new Error('Audio device routing unavailable')
        if (revision === this.revision) this.routed = true
      }).catch(() => { /* Keep silent if the chosen program output is unavailable. */ })
    }
    this.output.gain.value = !this.muted && this.routed ? 1 : 0
    if (this.muted || !this.routed) return
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    for (const cue of cues) this.play(cue)
  }

  private play(cue: TimerCue): void {
    const context = this.context!
    const now = context.currentTime
    const partials: Array<[number, number]> = cue === 'tick' ? [[1100, 0.1]] : [[220, 0.3], [440, 0.35], [660, 0.15]]
    const decay = cue === 'tick' ? 0.06 : 1.6
    for (const [frequency, volume] of partials) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = cue === 'tick' ? 'square' : 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(volume, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay)
      oscillator.connect(gain).connect(this.output!)
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
      oscillator.start(now)
      oscillator.stop(now + decay + 0.1)
    }
  }
}
