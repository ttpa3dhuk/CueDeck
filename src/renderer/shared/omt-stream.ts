import type { OmtInputFrame, OmtInputPacket } from '../../shared/omt-input'
import { onGpuFrame } from './omt-gpu'
import { t } from '../../shared/i18n'

interface NetworkState { status: 'connecting' | 'live' | 'error'; message: string | null; width: number; height: number; frameRate: number }

// Every source is received once in main, then once per renderer, even when it is in both desks.
const sessions = new Map<string, Set<OmtStream>>()
let unsubscribeGpu: (() => void) | null = null
let unsubscribe: (() => void) | null = null
let unsubscribeError: (() => void) | null = null
function retain(): void {
  void window.api.omtInput.retain([...sessions.keys()]).catch(error => {
    for (const set of sessions.values()) for (const stream of set) stream.fail(String(error))
  })
}
function subscribe(): void {
  if (unsubscribe) return
  unsubscribeGpu = onGpuFrame((frame, address, metadata) => {
    try { for (const stream of sessions.get(address) ?? []) stream.receiveGpu(frame.clone(), metadata) }
    finally { frame.close() }
  })
  unsubscribeError = window.api.omtInput.onError(error => {
    for (const address of error.addresses) for (const stream of sessions.get(address) ?? []) stream.fail(error.message)
  })
  unsubscribe = window.api.omtInput.onFrame((packet: OmtInputPacket) => {
    try {
      for (const stream of sessions.get(packet.address) ?? []) stream.receive(packet.frame)
    } finally { window.api.omtInput.ack(packet.sequence) }
  })
}

/** Native BGRA + planar audio → an ordinary MediaStream. Elements keep mute/volume/setSinkId ownership. */
export class OmtStream {
  readonly stream: MediaStream
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private video: CanvasCaptureMediaStreamTrack
  private audio: AudioContext | null = null
  private destination: MediaStreamAudioDestinationNode | null = null
  private audioGain: GainNode | null = null
  private audioNodes = new Set<AudioBufferSourceNode>()
  private audioNextAt: number | null = null
  private audioLastPts: number | null = null
  private audioLastDuration = 0
  private audioEnabled = true
  private pendingVideo: { frame: VideoFrame; timer: number }[] = []
  private originPts: number | null = null
  private originTime = 0
  private lastVideoAt = 0
  private startedAt = performance.now()
  private watchdog: number
  private disposed = false
  private width = 0
  private height = 0
  private frameRate = 0
  private state: NetworkState['status'] = 'connecting'
  private stateMessage: string | null = null

  constructor(private address: string, withAudio: boolean, private onState: (state: NetworkState) => void) {
    this.canvas.width = 16
    this.canvas.height = 16
    this.ctx = this.canvas.getContext('2d', { alpha: false })!
    this.stream = this.canvas.captureStream(0)
    this.video = this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
    if (withAudio) {
      this.audio = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      this.destination = this.audio.createMediaStreamDestination()
      this.destination.channelCount = 2
      this.destination.channelCountMode = 'explicit'
      this.audioGain = this.audio.createGain()
      this.audioGain.connect(this.destination)
      this.stream.addTrack(this.destination.stream.getAudioTracks()[0])
      void this.audio.resume()
    }
    subscribe()
    let set = sessions.get(address)
    if (!set) { set = new Set(); sessions.set(address, set) }
    set.add(this)
    retain()
    this.watchdog = window.setInterval(() => {
      if (performance.now() - (this.lastVideoAt || this.startedAt) > 5000) this.fail(t('Нет сигнала OMT. Ожидаем источник…'))
    }, 1000)
  }

  private notify(status: NetworkState['status'], message: string | null): void {
    if (this.disposed) return
    this.state = status
    this.stateMessage = message
    this.onState({ status, message, width: this.width, height: this.height, frameRate: this.frameRate })
  }
  fail(message: string): void {
    if (this.state !== 'error' || this.stateMessage !== message) this.notify('error', message)
  }

  setAudioEnabled(enabled: boolean): void {
    if (this.audioEnabled === enabled) return
    this.audioEnabled = enabled
    // Keep the stream clock running while muted; restarting the track makes
    // Chromium readjust MediaStream playout on every switch.
    if (this.audioGain) this.audioGain.gain.value = enabled ? 1 : 0
  }

  /** 80 ms playout buffer; restart the clock on source restart or a long network gap. */
  private presentationTime(timestamp: number, type: OmtInputFrame['type']): number {
    const pts = timestamp / 10000
    const now = performance.now()
    const predicted = this.originPts === null ? now + 80 : this.originTime + pts - this.originPts
    // Some senders use a different audio clock. Do not let it cancel every queued video frame.
    if (type === 'audio' && this.originPts !== null && (predicted < now - 200 || predicted > now + 500)) return now + 80
    if (this.originPts === null || (type === 'video' && (predicted < now - 200 || predicted > now + 160))) {
      this.clearVideoScheduled()
      this.originPts = pts
      this.originTime = now + 80
    }
    return this.originTime + pts - this.originPts!
  }

  receiveGpu(native: VideoFrame, frame: Extract<OmtInputFrame, { type: 'video' }>): void {
    if (this.disposed) { native.close(); return }
    this.scheduleVideo(native, frame, this.presentationTime(frame.timestamp, 'video'))
  }

  private scheduleVideo(native: VideoFrame, frame: Extract<OmtInputFrame, { type: 'video' }>, when: number): void {
    if (this.pendingVideo.length >= 6) { native.close(); return }
    const item = { frame: native, timer: 0 }
    item.timer = window.setTimeout(() => {
      const index = this.pendingVideo.indexOf(item)
      if (index >= 0) this.pendingVideo.splice(index, 1)
      try {
        if (this.disposed) return
        const changed = this.width !== frame.width || this.height !== frame.height
        if (changed) { this.canvas.width = frame.width; this.canvas.height = frame.height }
        this.ctx.drawImage(native, 0, 0)
        this.video.requestFrame()
        this.width = frame.width; this.height = frame.height
        this.frameRate = frame.frameRateD > 0 ? Math.round(frame.frameRateN / frame.frameRateD) : 0
        this.lastVideoAt = performance.now()
        if (this.state !== 'live' || changed) this.notify('live', null)
      } catch (error) { this.fail(t('Не удалось показать OMT: {error}', { error: String(error) })) }
      finally { native.close() }
    }, Math.max(0, when - performance.now()))
    this.pendingVideo.push(item)
  }

  receive(frame: OmtInputFrame): void {
    if (this.disposed) return
    if (frame.type === 'audio' && !this.audio) return
    try {
      const when = this.presentationTime(frame.timestamp, frame.type)
      if (frame.type === 'video') {
        let pixels = frame.data
        if ((frame.flags & 6) === 6) {
          // Raw VideoFrame expects straight alpha; libomt can return premultiplied pixels.
          pixels = new Uint8Array(pixels)
          for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
            const offset = y * frame.stride + x * 4
            const alpha = pixels[offset + 3]
            if (alpha > 0 && alpha < 255) for (let c = 0; c < 3; c++) pixels[offset + c] = Math.min(255, Math.round(pixels[offset + c] * 255 / alpha))
          }
        }
        const native = new VideoFrame(pixels, { format: frame.flags & 2 ? 'BGRA' : 'BGRX', codedWidth: frame.width, codedHeight: frame.height,
          timestamp: Math.round(frame.timestamp / 10), layout: [{ offset: 0, stride: frame.stride }] })
        this.scheduleVideo(native, frame, when)
      } else if (this.audio && this.destination) {
        if (this.audio.state === 'suspended') void this.audio.resume()
        const channels = Math.min(frame.channels, 8)
        const buffer = this.audio.createBuffer(channels, frame.samplesPerChannel, frame.sampleRate)
        for (let c = 0; c < channels; c++) buffer.copyToChannel(new Float32Array(frame.data.subarray(c * frame.samplesPerChannel, (c + 1) * frame.samplesPerChannel)), c)
        const target = this.audio.currentTime + Math.max(0, when - performance.now()) / 1000
        const pts = frame.timestamp / 10000
        const duration = frame.samplesPerChannel / frame.sampleRate
        const discontinuity = this.audioLastPts !== null &&
          (pts < this.audioLastPts - 1 || pts - this.audioLastPts - this.audioLastDuration * 1000 > 250)
        const underrun = this.audioNextAt !== null && this.audioNextAt < this.audio.currentTime
        // A delayed UI callback can deliver many buffers at once. Never start
        // them all at currentTime: that overlaps stereo samples and changes the tone.
        // Once started, contiguous PCM follows its sample clock. A callback
        // burst grows the queue and video can move `target`; neither means
        // the audio timeline broke. Comparing target with the queue tail
        // cancels valid buffers mid-burst and creates additional silence.
        // Rebuffer only on a source discontinuity or actual queue underrun.
        if (discontinuity || underrun) {
          this.clearAudioScheduled()
        }
        // Track received PTS even when the latency limit drops this packet.
        // Otherwise our own drops look like a source restart after 250ms
        // and cancel the still-valid bounded queue.
        this.audioLastPts = pts
        this.audioLastDuration = duration
        const start = this.audioNextAt ?? Math.max(this.audio.currentTime + 0.08, target)
        // Bound latency if callbacks arrive much faster than their sample clock.
        if (start - this.audio.currentTime > 0.5) return
        const node = this.audio.createBufferSource()
        node.buffer = buffer
        node.connect(this.audioGain!)
        this.audioNodes.add(node)
        node.onended = () => { node.disconnect(); this.audioNodes.delete(node) }
        node.start(start)
        this.audioNextAt = start + duration
      }
    } catch (error) { this.fail(t('Не удалось показать OMT: {error}', { error: String(error) })) }
  }

  private clearVideoScheduled(): void {
    for (const item of this.pendingVideo) { window.clearTimeout(item.timer); item.frame.close() }
    this.pendingVideo = []
  }
  private clearAudioScheduled(): void {
    for (const node of this.audioNodes) { try { node.stop(); node.disconnect() } catch { /* already ended */ } }
    this.audioNodes.clear()
    this.audioNextAt = null
    this.audioLastPts = null
    this.audioLastDuration = 0
  }
  private clearScheduled(): void {
    this.clearVideoScheduled()
    this.clearAudioScheduled()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.clearInterval(this.watchdog)
    this.clearScheduled()
    this.stream.getTracks().forEach(track => track.stop())
    if (this.audio) void this.audio.close()
    const set = sessions.get(this.address)
    set?.delete(this)
    if (!set?.size) sessions.delete(this.address)
    retain()
    if (!sessions.size) { unsubscribeGpu?.(); unsubscribeGpu = null; unsubscribe?.(); unsubscribe = null; unsubscribeError?.(); unsubscribeError = null }
  }
}

function disposeAll(): void {
  for (const set of [...sessions.values()]) for (const stream of [...set]) stream.dispose()
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', disposeAll)
import.meta.hot?.dispose(disposeAll)
