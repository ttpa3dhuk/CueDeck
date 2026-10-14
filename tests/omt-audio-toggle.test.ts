import { afterEach, expect, it, vi } from 'vitest'
import { LivePool, LiveView } from '../src/renderer/shared/live-stream'
import { makeLiveUri } from '../src/shared/live'
const mocks = vi.hoisted(() => ({ instances: [] as any[] }))
vi.mock('../src/renderer/shared/omt-stream', () => ({ OmtStream: class {
  stream = { getTracks: () => [{ stop: vi.fn() }] }
  dispose = vi.fn()
  setAudioEnabled = vi.fn()
  constructor(_address: string, _audio: boolean, public notify: (s: any) => void) { mocks.instances.push(this) }
} }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); mocks.instances.length = 0 })
it('keeps the same OMT stream and video playback across repeated audio URI changes', () => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { mediaDevices: { addEventListener: vi.fn() } })
  vi.stubGlobal('window', { setInterval, clearInterval })
  const pool = new LivePool()
  const uri = (on: boolean) => makeLiveUri({ kind: 'omt', omtAddress: 'HOST (vMix)', videoLabel: 'HOST (vMix)', audioLabel: on ? 'HOST (vMix)' : null })
  pool.retain([uri(true)])
  const receiver = mocks.instances[0]
  receiver.notify({ status: 'live', message: null, width: 1920, height: 1080, frameRate: 25 })
  const el: any = { srcObject: null, classList: { remove: vi.fn(), toggle: vi.fn() }, play: vi.fn(async () => {}) }
  const view = new LiveView(el, pool)
  view.show(uri(true))
  for (const enabled of [false, true, false, true]) {
    pool.retain([uri(enabled)])
    expect(pool.get(uri(enabled))).toBe(receiver.stream)
    expect(pool.stateOf(uri(enabled)).status).toBe('live')
    view.show(uri(enabled))
    expect(receiver.setAudioEnabled).toHaveBeenLastCalledWith(enabled)
  }
  expect(mocks.instances).toHaveLength(1)
  expect(receiver.dispose).not.toHaveBeenCalled()
  expect(el.play).toHaveBeenCalledOnce()
  expect(el.classList.toggle).not.toHaveBeenCalledWith('hidden', true)
  pool.retain([])
  expect(receiver.dispose).toHaveBeenCalledOnce()
})
