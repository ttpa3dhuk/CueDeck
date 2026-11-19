const EDGE_SECONDS = 0.018

type RoutedContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

interface Channel {
  node: MediaElementAudioSourceNode
  gain: GainNode
  muted: boolean
  closing: boolean
  target: number
  playing: () => void
}

/** Keep one audio output open across PPTX cues and videos. */
export class PptxAudioOutput {
  private context?: RoutedContext
  private channels = new Map<HTMLMediaElement, Channel>()
  private sink: string | undefined
  private routing: Promise<void> = Promise.resolve()
  private routed = false
  private switches = new WeakMap<HTMLMediaElement, 'waiting' | 'ready'>()

  configure(el: HTMLMediaElement, muted: boolean, deviceId: string | null): boolean {
    let channel = this.channels.get(el)
    if (!channel) {
      if (muted || el.crossOrigin !== 'anonymous') return false
      try {
        const context = this.context ?? new AudioContext({ latencyHint: 'interactive' }) as RoutedContext
        if (typeof context.setSinkId !== 'function') {
          void context.close().catch(() => undefined)
          return false
        }
        this.context = context
        const gain = context.createGain()
        gain.gain.value = 0
        const node = context.createMediaElementSource(el)
        node.connect(gain).connect(context.destination)
        channel = { node, gain, muted, closing: false, target: 0, playing: () => this.refresh(el) }
        this.channels.set(el, channel)
        el.addEventListener('playing', channel.playing)
        el.addEventListener('seeked', channel.playing)
        void context.resume().catch(() => undefined)
      } catch {
        return false
      }
    }
    if (this.switches.get(el) === 'ready') {
      this.switches.delete(el)
      channel.closing = false
    }
    channel.muted = muted
    this.selectSink(deviceId ?? '')
    this.refresh(el)
    return true
  }

  has(el: HTMLMediaElement): boolean { return this.channels.has(el) }

  /** Wait only until the old audio is silent, then let the renderer change src. */
  holdForSwitch(el: HTMLMediaElement, refresh: () => void): boolean {
    const pending = this.switches.get(el)
    if (pending) return pending === 'waiting'
    const channel = this.channels.get(el)
    if (!channel || !channel.target || el.paused || el.ended) return false
    this.switches.set(el, 'waiting')
    channel.closing = true
    this.ramp(channel, 0)
    setTimeout(() => {
      if (this.switches.get(el) !== 'waiting') return
      this.switches.set(el, 'ready')
      refresh()
    }, EDGE_SECONDS * 1000 + 4)
    return true
  }

  retire(el: HTMLMediaElement, dispose: () => void): void {
    const channel = this.channels.get(el)
    if (!channel) { dispose(); return }
    channel.closing = true
    this.ramp(channel, 0)
    setTimeout(() => {
      this.channels.delete(el)
      el.removeEventListener('playing', channel.playing)
      el.removeEventListener('seeked', channel.playing)
      channel.node.disconnect()
      channel.gain.disconnect()
      dispose()
    }, EDGE_SECONDS * 1000 + 4)
  }

  private selectSink(sink: string): void {
    if (this.sink === sink) return
    const context = this.context!
    // A newly created context is already on the default output.
    if (this.sink === undefined && !sink) { this.sink = sink; this.routed = true; return }
    this.sink = sink
    this.routed = false
    for (const el of this.channels.keys()) this.refresh(el)
    this.routing = this.routing.catch(() => undefined).then(async () => {
      if (this.sink !== sink) return
      try { await context.setSinkId!(sink) }
      catch {
        if (this.sink !== sink) return
        try { await context.setSinkId!('') } catch { /* retain the last working route */ }
      }
      if (this.sink !== sink) return
      this.routed = true
      for (const el of this.channels.keys()) this.refresh(el)
    })
  }

  private refresh(el: HTMLMediaElement): void {
    const channel = this.channels.get(el)
    if (!channel) return
    const target = this.routed && !channel.muted && !channel.closing && !el.paused && !el.seeking && el.readyState >= 2 ? 1 : 0
    this.ramp(channel, target)
  }

  private ramp(channel: Channel, target: number): void {
    if (channel.target === target) return
    channel.target = target
    const time = this.context!.currentTime
    const gain = channel.gain.gain
    gain.cancelAndHoldAtTime(time)
    gain.linearRampToValueAtTime(target, time + EDGE_SECONDS)
  }
}
