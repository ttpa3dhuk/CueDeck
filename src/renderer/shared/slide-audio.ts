import type { AppState, Role, SlideAudioCue, SlideMedia } from '../../shared/types'
import { applySinkId, shouldMute, slideVideoSrc } from './video'
import { PptxAudioOutput } from './pptx-audio-output'

/** The deck's auxiliary cues follow the same output role and mute as its video. */
export class SlideAudio {
  readonly output = new PptxAudioOutput()
  private tracks = new Map<string, HTMLAudioElement>()
  private transitionTracks = new Map<string, HTMLAudioElement>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private transitionTimers = new Set<ReturnType<typeof setTimeout>>()
  private lastClick = ''
  private transitionKey: string | undefined
  private key = ''
  private menuOpen = false
  private sinks = new WeakMap<HTMLAudioElement, string | null>()

  clear(): void {
    this.release(this.tracks, this.timers)
    this.key = ''
    this.menuOpen = false
  }

  private release(tracks: Map<string, HTMLAudioElement>, timers: Set<ReturnType<typeof setTimeout>>): void {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const track of tracks.values()) this.releaseTrack(track)
    tracks.clear()
  }

  private releaseTrack(track: HTMLAudioElement): void {
    // A decaying track is gone from the active cue inventory immediately.
    delete track.dataset.pptxCue
    this.output.retire(track, () => {
      track.pause()
      track.removeAttribute('src')
      track.load()
      track.remove()
    })
  }

  updateTransition(state: AppState, role: Role): void {
    const event = state.slideAudioClick
    const active = event && event.slide !== state.currentSlide && event.sha === state.pdfSha1 &&
      event.takeId === state.takeTransition?.id ? event : undefined
    if (this.transitionKey !== active?.id) {
      this.release(this.transitionTracks, this.transitionTimers)
      this.transitionKey = active?.id
      if (active && Date.now() - active.at < 2500) {
        this.play(active.cues.filter(cue => !cue.loop), active.sha, state, role, this.transitionTracks, this.transitionTimers, active.at)
      }
    }
    this.route(this.transitionTracks, state, role)
  }

  update(media: SlideMedia | undefined, state: AppState, role: Role): void {
    const sha = state.pdfSha1
    if (!media?.audio?.length || !sha) { this.clear(); return }
    const key = `${sha}:${media.slide}:${state.takeTransition?.id ?? ''}`
    if (this.key !== key) {
      this.clear()
      this.key = key
      this.menuOpen = Boolean(state.slideMenuOpen)
      this.play(media.audio.filter(cue => cue.trigger === 'enter'), sha, state, role)
    } else if (state.slideMenuOpen && !this.menuOpen) {
      this.menuOpen = true
      this.play(media.audio.filter(cue => cue.trigger === 'menu'), sha, state, role)
    }
    const click = state.slideAudioClick
    if (click && click.sha === sha && click.slide === media.slide && click.takeId === state.takeTransition?.id &&
        click.id !== this.lastClick && Date.now() - click.at < 2500) {
      this.lastClick = click.id
      this.play(click.cues, sha, state, role, this.tracks, this.timers, click.at)
    }
    this.route(this.tracks, state, role)
  }

  private route(tracks: Map<string, HTMLAudioElement>, state: AppState, role: Role): void {
    for (const track of tracks.values()) this.routeTrack(track, state, role)
  }

  private routeTrack(track: HTMLAudioElement, state: AppState, role: Role): void {
    const muted = shouldMute(state, role)
    const routed = this.output.configure(track, muted, state.audioOutputId)
    track.muted = muted
    if (!routed && (this.sinks.has(track) || state.audioOutputId) && this.sinks.get(track) !== state.audioOutputId) {
      this.sinks.set(track, state.audioOutputId)
      void applySinkId(track, state.audioOutputId)
    }
  }

  private play(cues: SlideAudioCue[], sha: string, state: AppState, role: Role,
    tracks = this.tracks, timers = this.timers, at = Date.now()): void {
    const start = (cue: SlideAudioCue): void => {
      const previous = tracks.get(cue.file)
      if (previous) this.releaseTrack(previous)
      const track = document.createElement('audio')
      track.crossOrigin = 'anonymous'
      track.dataset.pptxCue = cue.file
      track.src = slideVideoSrc('program', cue.file, sha)
      document.body.append(track)
      tracks.set(cue.file, track)
      track.loop = cue.loop
      track.volume = cue.volume
      this.routeTrack(track, state, role)
      void track.play().catch(error => {
        if (error.name !== 'AbortError') console.warn('PPTX audio cue failed', error)
      })
    }
    for (const cue of cues) {
      const delay = at + (cue.delayMs ?? 0) - Date.now()
      if (delay <= 0) { start(cue); continue }
      const timer = setTimeout(() => { timers.delete(timer); start(cue) }, delay)
      timers.add(timer)
    }
  }
}
