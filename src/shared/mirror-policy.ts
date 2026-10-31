export interface MirrorObservation {
  timeline: string
  playing: boolean
  paused: boolean
  ended: boolean
  visible: boolean
  width: number
  height: number
  seeking: boolean
  readyState: number
  colorSafe: boolean
  consumers: boolean
}

/** Promote once per source, only after sustained decode/seek pressure. */
export class MirrorPolicy {
  sharing: boolean
  private timeline = ''
  private playingSince = 0
  private frameAt = 0
  constructor(forced = false) { this.sharing = forced }
  frame(now: number): void { this.frameAt = now }
  observe(now: number, value: MirrorObservation): boolean {
    if (this.sharing) return false
    if (value.timeline !== this.timeline) {
      this.timeline = value.timeline; this.playingSince = now; this.frameAt = now
    }
    if (!value.playing || value.paused || value.ended || !value.visible || !value.colorSafe || !value.consumers ||
      value.width * value.height < 1920 * 1080) return false
    if (now - this.playingSince < 2000 || now - this.frameAt < 1000 || (!value.seeking && value.readyState >= 3)) return false
    this.sharing = true
    return true
  }
}
