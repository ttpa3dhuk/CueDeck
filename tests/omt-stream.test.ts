import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmtInputFrame, OmtInputPacket } from '../src/shared/omt-input'

const source = 'HOST (CueDeck Audience)'
let receiver: ((packet: OmtInputPacket) => void) | null
let retain: ReturnType<typeof vi.fn>, ack: ReturnType<typeof vi.fn>, unsubscribe: ReturnType<typeof vi.fn>
let draw: ReturnType<typeof vi.fn>, requestFrame: ReturnType<typeof vi.fn>
let nodes: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; buffer: unknown }[]
let copied: { channel: number; values: number[] }[]
let frames: { close: ReturnType<typeof vi.fn> }[]
let trackStop: ReturnType<typeof vi.fn>, audioClose: ReturnType<typeof vi.fn>
let OmtStream: typeof import('../src/renderer/shared/omt-stream')['OmtStream']
let streams: InstanceType<typeof OmtStream>[]
let audioTime: number

function video(timestamp = 10000000): OmtInputFrame {
  return { type: 'video', data: new Uint8Array(16), width: 2, height: 2, stride: 8,
    flags: 0, timestamp, frameRateN: 30, frameRateD: 1 }
}
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  receiver = null
  nodes = []; copied = []; frames = []; streams = []; audioTime = 0
  retain = vi.fn(async () => undefined); ack = vi.fn(); unsubscribe = vi.fn()
  draw = vi.fn(); requestFrame = vi.fn(); trackStop = vi.fn(); audioClose = vi.fn(async () => undefined)
  const videoTrack = { requestFrame, stop: trackStop }
  class FakeMediaStream {
    tracks: unknown[] = [videoTrack]
    getVideoTracks() { return [videoTrack] }
    getAudioTracks() { return this.tracks.slice(1) }
    getTracks() { return this.tracks }
    addTrack(track: unknown) { this.tracks.push(track) }
  }
  class FakeAudioContext {
    get currentTime() { return audioTime }
    state = 'running'
    resume = vi.fn(async () => undefined)
    close = audioClose
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ stop: trackStop }] } } }
    createBuffer(channels: number, samples: number, rate: number) {
      return { channels, samples, rate, copyToChannel: (data: Float32Array, channel: number) => copied.push({ channel, values: [...data] }) }
    }
    createBufferSource() {
      const node = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }
      nodes.push(node)
      return node
    }
  }
  class FakeVideoFrame {
    close = vi.fn()
    constructor() { frames.push(this) }
  }
  vi.stubGlobal('performance', { now: () => Date.now() })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('VideoFrame', FakeVideoFrame)
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage: draw }), captureStream: () => new FakeMediaStream() }) })
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: vi.fn(),
    api: { omtInput: { retain, ack, onError: () => vi.fn(), onFrame: (callback: typeof receiver) => { receiver = callback; return unsubscribe } } },
  })
  OmtStream = (await import('../src/renderer/shared/omt-stream')).OmtStream
})
afterEach(() => {
  streams.forEach(stream => stream.dispose())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function open(withAudio = false, onState = vi.fn()) {
  const stream = new OmtStream(source, withAudio, onState)
  streams.push(stream)
  return stream
}

describe('OMT renderer playout', () => {
  it('toggles audio without stopping the video track or its scheduled frame', () => {
    const stream = open(true)
    const tracks = stream.stream.getTracks()
    stream.receive(video())
    stream.setAudioEnabled(false)
    expect(stream.stream.getAudioTracks()[0].enabled).toBe(false)
    vi.advanceTimersByTime(80)
    expect(draw).toHaveBeenCalledOnce()
    expect(trackStop).not.toHaveBeenCalled()
    stream.setAudioEnabled(true)
    expect(stream.stream.getTracks()).toEqual(tracks)
    expect(stream.stream.getAudioTracks()[0].enabled).toBe(true)
  })
  it('rebuffers a clock skew after a dialog instead of cancelling all video forever', () => {
    const stream = open()
    stream.receive(video())
    vi.advanceTimersByTime(80)
    // A delayed first packet establishes a clock 340ms behind the next packets.
    for (let index = 0; index < 25; index++) {
      stream.receive(video(14200000 + index * 400000))
      vi.advanceTimersByTime(40)
    }
    expect(draw.mock.calls.length).toBeGreaterThan(20)
  })

  it('a full video queue preserves the earliest deadline while packets keep arriving', () => {
    const stream = open()
    for (let index = 0; index < 12; index++) {
      stream.receive(video(10000000 + index * 50000))
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(25)
    expect(draw).toHaveBeenCalled()
  })

  it('restarts audio after a UI underrun without overlapping stale stereo buffers', () => {
    const stream = open(true)
    const chunk = { type: 'audio' as const, data: new Float32Array(1920), sampleRate: 48000,
      channels: 2, samplesPerChannel: 960, timestamp: 10000000 }
    stream.receive(chunk)
    vi.advanceTimersByTime(1000)
    audioTime = 1
    stream.receive({ ...chunk, timestamp: 20000000 })
    stream.receive({ ...chunk, timestamp: 20200000 })
    expect(nodes[0].stop).toHaveBeenCalledOnce()
    expect(nodes[1].start.mock.calls[0][0]).toBeCloseTo(1.08)
    expect(nodes[2].start.mock.calls[0][0]).toBeCloseTo(1.1)
  })

  it('video timestamp resets cannot cancel playing audio', () => {
    const stream = open(true)
    stream.receive({ type: 'audio', data: new Float32Array(1920), sampleRate: 48000,
      channels: 2, samplesPerChannel: 960, timestamp: 10000000 })
    stream.receive(video(1000000000))
    expect(nodes[0].stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(80)
    expect(draw).toHaveBeenCalledOnce()
  })

  it('a moderate audio clock offset cannot cancel queued video', () => {
    const stream = open(true)
    stream.receive(video())
    stream.receive({ type: 'audio', data: new Float32Array(1920), sampleRate: 48000,
      channels: 2, samplesPerChannel: 960, timestamp: 12000000 })
    vi.advanceTimersByTime(80)
    expect(draw).toHaveBeenCalledOnce()
  })

  it('keeps adjacent audio chunks contiguous even with more than 40ms delivery jitter', () => {
    const stream = open(true)
    const chunk = { type: 'audio' as const, data: new Float32Array(1920), sampleRate: 48000,
      channels: 2, samplesPerChannel: 960, timestamp: 10000000 }
    stream.receive(chunk)
    vi.advanceTimersByTime(50)
    audioTime = 0.05
    stream.receive({ ...chunk, timestamp: 10200000 })
    expect(nodes[1].start.mock.calls[0][0]).toBeCloseTo(0.1)
    expect(nodes[0].stop).not.toHaveBeenCalled()
  })

  it('plays video after its jitter buffer and acknowledges receipt immediately', () => {
    const state = vi.fn()
    open(false, state)
    receiver!({ address: source, sequence: 1, frame: video() })
    expect(ack).toHaveBeenCalledWith(1)
    expect(draw).not.toHaveBeenCalled()
    vi.advanceTimersByTime(79)
    expect(draw).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(draw).toHaveBeenCalledTimes(1)
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(frames[0].close).toHaveBeenCalledTimes(1)
    expect(state.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'live', width: 2, height: 2 })
  })

  it('bounds queued VideoFrames and releases every frame on disposal', () => {
    const stream = open()
    for (let index = 0; index < 10; index++) stream.receive(video())
    expect(frames.filter(frame => frame.close.mock.calls.length === 0)).toHaveLength(6)
    stream.dispose()
    vi.advanceTimersByTime(1000)
    expect(draw).not.toHaveBeenCalled()
    expect(frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true)
    expect(trackStop).toHaveBeenCalled()
  })

  it('schedules planar audio in its original channels and cancels playback on disposal', () => {
    const stream = open(true)
    stream.receive({ type: 'audio', data: new Float32Array([1, 2, 3, 4]),
      sampleRate: 48000, channels: 2, samplesPerChannel: 2, timestamp: 10000000 })
    expect(copied).toEqual([{ channel: 0, values: [1, 2] }, { channel: 1, values: [3, 4] }])
    expect(nodes[0].start).toHaveBeenCalledWith(0.08)
    stream.dispose()
    expect(nodes[0].stop).toHaveBeenCalledTimes(1)
    expect(audioClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the shared subscription while another view still owns the source', () => {
    const first = open(), second = open()
    first.dispose()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(retain.mock.calls.at(-1)?.[0]).toEqual([source])
    second.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(retain.mock.calls.at(-1)?.[0]).toEqual([])
  })

  it('reports no signal and recovers on a later valid video frame', () => {
    const state = vi.fn()
    const stream = open(false, state)
    vi.advanceTimersByTime(6000)
    expect(state.mock.calls.at(-1)?.[0].status).toBe('error')
    stream.receive(video())
    vi.advanceTimersByTime(80)
    expect(state.mock.calls.at(-1)?.[0].status).toBe('live')
  })

  it('keeps video playing when audio uses a different timestamp clock', () => {
    const stream = open(true)
    stream.receive(video())
    stream.receive({ type: 'audio', data: new Float32Array(1920), sampleRate: 48000,
      channels: 2, samplesPerChannel: 960, timestamp: 1000000000 })
    vi.advanceTimersByTime(80)
    expect(draw).toHaveBeenCalledTimes(1)
    expect(nodes[0].start).toHaveBeenCalledWith(0.08)
  })

  it('ignored audio cannot reset a muted source video clock', () => {
    const stream = open(false)
    stream.receive(video())
    stream.receive({ type: 'audio', data: new Float32Array(1920), sampleRate: 48000,
      channels: 2, samplesPerChannel: 960, timestamp: 1000000000 })
    vi.advanceTimersByTime(80)
    expect(draw).toHaveBeenCalledTimes(1)
    expect(nodes).toHaveLength(0)
  })

  it('plays consecutive audio buffers without gaps from callback jitter', () => {
    const stream = open(true)
    const chunk = { type: 'audio' as const, data: new Float32Array(1920), sampleRate: 48000,
      channels: 2, samplesPerChannel: 960, timestamp: 10000000 }
    stream.receive(chunk)
    vi.advanceTimersByTime(23)
    stream.receive({ ...chunk, timestamp: 10200000 })
    expect(nodes[0].start.mock.calls[0][0]).toBeCloseTo(0.08)
    expect(nodes[1].start.mock.calls[0][0]).toBeCloseTo(0.1)
  })
})

describe('GPU video frame lifecycle', () => {
  it('renders an imported frame on the existing video clock and closes it', () => {
    const stream = new OmtStream(source, false, vi.fn()); streams.push(stream)
    const native = { close: vi.fn() } as unknown as VideoFrame
    stream.receiveGpu(native, video() as Extract<OmtInputFrame, { type: 'video' }>)
    expect(draw).not.toHaveBeenCalled()
    vi.advanceTimersByTime(80)
    expect(draw).toHaveBeenCalledWith(native, 0, 0)
    expect(requestFrame).toHaveBeenCalledOnce()
    expect(native.close).toHaveBeenCalledOnce()
  })
  it('closes queued GPU frames on disposal and rejects frames received afterwards', () => {
    const stream = new OmtStream(source, false, vi.fn()); streams.push(stream)
    const queued = { close: vi.fn() } as unknown as VideoFrame
    const late = { close: vi.fn() } as unknown as VideoFrame
    stream.receiveGpu(queued, video() as Extract<OmtInputFrame, { type: 'video' }>)
    stream.dispose()
    stream.receiveGpu(late, video() as Extract<OmtInputFrame, { type: 'video' }>)
    vi.advanceTimersByTime(100)
    expect(draw).not.toHaveBeenCalled()
    expect(queued.close).toHaveBeenCalledOnce()
    expect(late.close).toHaveBeenCalledOnce()
  })
})
