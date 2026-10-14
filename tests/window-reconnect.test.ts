import { afterEach, expect, it, vi } from 'vitest'
import { LivePool } from '../src/renderer/shared/live-stream'
import { makeLiveUri } from '../src/shared/live'

vi.mock('../src/renderer/shared/omt-stream', () => ({ OmtStream: vi.fn() }))
vi.mock('../src/renderer/shared/window-crop', () => ({ cropWindowStream: async (stream: any) => ({ stream, dispose: vi.fn(), setFps: vi.fn() }) }))

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('replaces a stale capture when a slideshow creates a new window, even if its old track stays live', async () => {
  vi.useFakeTimers()
  let id: string | null = 'window:1:0'
  const streams: any[] = []
  const getUserMedia = vi.fn(async () => {
    const track = { readyState: 'live', muted: false, applyConstraints: vi.fn(async () => {}), getConstraints: () => ({}), getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }), stop: vi.fn(() => { track.readyState = 'ended' }) }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
    streams.push(stream)
    return stream
  })
  vi.stubGlobal('navigator', { mediaDevices: { addEventListener: vi.fn(), getUserMedia } })
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval,
    api: { live: { windowFps: vi.fn(async () => 30), resolveWindow: vi.fn(async () => { if (!id) throw new Error('gone'); return id }) } } })
  vi.stubGlobal('MediaStream', class {
    constructor(private tracks: any[]) {}
    getTracks() { return this.tracks }
  })
  const pool = new LivePool()
  const uri = makeLiveUri({ kind: 'window', videoLabel: 'PowerPoint', windowId: 'window:1:0', audioLabel: null })
  pool.retain([uri])
  await vi.advanceTimersByTimeAsync(0)
  expect(pool.stateOf(uri).status).toBe('live')
  expect(pool.borrowWindowSource('window:1:0', 'PowerPoint')).toBe(streams[0])
  expect(pool.borrowWindowSource('window:other:0', 'PowerPoint')).toBeNull()
  const faster = makeLiveUri({ kind: 'window', videoLabel: 'PowerPoint', windowId: 'window:1:0', audioLabel: null, windowFps: 25 })
  pool.retain([faster])
  await vi.advanceTimersByTimeAsync(0)
  expect(pool.get(faster)).toBe(streams[0])
  expect(getUserMedia).toHaveBeenCalledOnce()
  expect(streams[0].getTracks()[0].stop).not.toHaveBeenCalled()
  expect(streams[0].getTracks()[0].applyConstraints).not.toHaveBeenCalled()
  pool.retain([uri])
  await vi.advanceTimersByTimeAsync(0)
  streams[0].getTracks()[0].muted = true
  await vi.advanceTimersByTimeAsync(8000)
  expect(getUserMedia).toHaveBeenCalledOnce()
  expect(pool.stateOf(uri).status).toBe('live')
  streams[0].getTracks()[0].muted = false
  id = 'window:2:0'
  await vi.advanceTimersByTimeAsync(2000)
  expect(streams[0].getTracks()[0].stop).toHaveBeenCalledOnce()
  expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ video: expect.objectContaining({ mandatory: expect.objectContaining({ chromeMediaSourceId: id }) }) }))
  expect(pool.stateOf(uri).status).toBe('live')
  id = null
  await vi.advanceTimersByTimeAsync(2000)
  expect(pool.stateOf(uri).status).toBe('live')
  await vi.advanceTimersByTimeAsync(4000)
  expect(pool.stateOf(uri).status).toBe('live')
  streams.at(-1).getTracks()[0].readyState = 'ended'
  await vi.advanceTimersByTimeAsync(2000)
  expect(pool.stateOf(uri).status).toBe('error')
  id = 'window:3:0'
  await vi.advanceTimersByTimeAsync(6000)
  expect(pool.stateOf(uri).status).toBe('live')
  pool.retain([])
  expect(streams.at(-1).getTracks()[0].stop).toHaveBeenCalledOnce()
})
