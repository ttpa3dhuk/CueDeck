import { afterEach, expect, it, vi } from 'vitest'
import { LiveMeter, elementAudioStream } from '../src/renderer/shared/live-stream'
vi.mock('../src/renderer/shared/omt-stream', () => ({ OmtStream: vi.fn() }))

afterEach(() => vi.unstubAllGlobals())

it('attaches when a paused capture gains an audio track and releases ended tracks', () => {
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const analyser = { disconnect: vi.fn(), fftSize: 0 }
  const createMediaStreamSource = vi.fn(() => source)
  vi.stubGlobal('AudioContext', class {
    state = 'running'
    createMediaStreamSource = createMediaStreamSource
    createAnalyser = () => analyser
  })
  const interval = vi.fn(() => 1), clear = vi.fn()
  vi.stubGlobal('window', { setInterval: interval, clearInterval: clear })
  const tracks: Array<{ readyState: string }> = []
  const stream = { getAudioTracks: () => tracks } as unknown as MediaStream
  const meter = new LiveMeter()
  meter.attach(stream)
  expect(meter.hasAudio()).toBe(false)
  tracks.push({ readyState: 'live' })
  meter.attach(stream)
  expect(meter.hasAudio()).toBe(true)
  meter.attach(stream)
  expect(createMediaStreamSource).toHaveBeenCalledOnce()
  tracks[0].readyState = 'ended'
  meter.attach(stream)
  expect(meter.hasAudio()).toBe(false)
  expect(source.disconnect).toHaveBeenCalledOnce()
  expect(clear).toHaveBeenCalledOnce()
})

it('reuses a capture stream while its tracks appear after playback starts', () => {
  const stream = { getAudioTracks: () => [] }
  const captureStream = vi.fn(() => stream)
  const element = { currentSrc: 'cuedeck-media://stream/program?v=test', captureStream } as unknown as HTMLMediaElement
  expect(elementAudioStream(element)).toBe(stream)
  expect(elementAudioStream(element)).toBe(stream)
  expect(captureStream).toHaveBeenCalledOnce()
})
