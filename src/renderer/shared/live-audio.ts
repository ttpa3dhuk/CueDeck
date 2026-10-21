/** Play generated OMT PCM without HTMLMediaElement's adaptive live clock. */
type RoutedContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

export class LiveAudio {
  private context: RoutedContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private gain: GainNode | null = null
  private stream: MediaStream | null = null
  private sink: string | undefined
  private routed = false
  private revision = 0
  private muted = true
  private volume = 1

  attach(stream: MediaStream | null): boolean {
    if (stream === this.stream) return this.context !== null
    this.detach()
    if (!stream?.getAudioTracks().length) return false
    const context = new AudioContext({ sampleRate: 48000 }) as RoutedContext
    // Keep the existing media-element route on runtimes without device routing.
    if (typeof context.setSinkId !== 'function') { void context.close(); return false }
    this.context = context
    this.stream = stream
    this.source = context.createMediaStreamSource(stream)
    this.gain = context.createGain()
    this.gain.gain.value = 0
    this.source.connect(this.gain).connect(context.destination)
    void context.resume()
    return true
  }

  configure(muted: boolean, deviceId: string | null, volume = 1): void {
    this.muted = muted
    this.volume = volume
    const context = this.context
    if (!context) return
    const sink = deviceId ?? ''
    if (sink !== this.sink) {
      this.sink = sink
      this.routed = false
      this.updateGain()
      const revision = ++this.revision
      // Serialize device changes so an older asynchronous route cannot win.
      this.routing = this.routing.catch(() => undefined).then(async () => {
        if (this.context !== context || revision !== this.revision) return
        try { await context.setSinkId!(sink) }
        catch {
          if (this.context !== context || revision !== this.revision) return
          try { await context.setSinkId!('') } catch { return }
        }
        if (this.context !== context || revision !== this.revision) return
        this.routed = true
        this.updateGain()
      })
    }
    this.updateGain()
  }

  private routing: Promise<void> = Promise.resolve()

  private updateGain(): void {
    if (this.gain) this.gain.gain.value = this.routed && !this.muted ? this.volume : 0
  }

  detach(): void {
    ++this.revision
    this.gain?.disconnect()
    this.source?.disconnect()
    if (this.context) void this.context.close()
    this.context = null
    this.source = null
    this.gain = null
    this.stream = null
    this.sink = undefined
    this.routed = false
  }
}
