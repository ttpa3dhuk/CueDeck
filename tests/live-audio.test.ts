import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LiveAudio } from '../src/renderer/shared/live-audio'

let contexts: any[]
const stream = () => ({ getAudioTracks: () => [{}] }) as unknown as MediaStream
beforeEach(() => {
  contexts = []
  class Context {
    destination = {}
    gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    source = { connect: vi.fn(() => this.gain), disconnect: vi.fn() }
    setSinkId = vi.fn(async (_id: string) => {})
    resume = vi.fn(async () => {})
    close = vi.fn(async () => {})
    createMediaStreamSource = vi.fn(() => this.source)
    createGain = vi.fn(() => this.gain)
    constructor() { contexts.push(this) }
  }
  vi.stubGlobal('AudioContext', Context)
})
afterEach(() => vi.unstubAllGlobals())
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

it('keeps the source through mute and routes program and PFL independently', async () => {
  const program = new LiveAudio(), pfl = new LiveAudio(), input = stream()
  program.attach(input); pfl.attach(input)
  program.configure(false, 'hall'); pfl.configure(true, 'phones')
  expect(contexts[0].gain.gain.value).toBe(0) // no sound before routing
  await settle()
  expect(contexts[0].setSinkId).toHaveBeenCalledWith('hall')
  expect(contexts[1].setSinkId).toHaveBeenCalledWith('phones')
  expect(contexts[0].gain.gain.value).toBe(1)
  expect(contexts[1].gain.gain.value).toBe(0)
  program.configure(true, 'hall'); pfl.configure(false, 'phones', 0.5)
  expect(contexts[0].gain.gain.value).toBe(0)
  expect(contexts[1].gain.gain.value).toBe(0.5)
  expect(program.attach(input)).toBe(true)
  expect(contexts).toHaveLength(2)
  program.detach(); pfl.detach()
  expect(contexts.every(c => c.close.mock.calls.length === 1)).toBe(true)
})

it('does not let a stale failed device route fall back over the latest selection', async () => {
  const audio = new LiveAudio(); audio.attach(stream())
  let reject!: (error: Error) => void
  contexts[0].setSinkId.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  audio.configure(false, 'old'); await settle()
  audio.configure(false, 'new')
  reject(new Error('device removed')); await settle()
  expect(contexts[0].setSinkId.mock.calls).toEqual([['old'], ['new']])
  expect(contexts[0].gain.gain.value).toBe(1)
  audio.detach()
})

it('falls back to default for a missing device and stays silent after detach', async () => {
  const audio = new LiveAudio(); audio.attach(stream())
  contexts[0].setSinkId.mockRejectedValueOnce(new Error('gone'))
  audio.configure(false, 'gone'); await settle()
  expect(contexts[0].setSinkId.mock.calls).toEqual([['gone'], ['']])
  expect(contexts[0].gain.gain.value).toBe(1)
  audio.attach(null)
  expect(contexts[0].source.disconnect).toHaveBeenCalledOnce()
  expect(contexts[0].gain.disconnect).toHaveBeenCalledOnce()
})
