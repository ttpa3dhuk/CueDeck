import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import type { NdiLib } from '../src/main/ndi/libndi-native'
import { NdiSender } from '../src/main/ndi/sender'
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))

function fixture() {
  const sends: Array<{ frame: any; done: (error: Error | null) => void }> = []
  const destroys: Array<(error: Error | null) => void> = []
  const lib = {
    sendCreate: vi.fn(() => ({ instance: 1 })),
    sendVideoAsync: { async: vi.fn((_inst, frame, done) => sends.push({ frame, done })) },
    sendDestroy: Object.assign(vi.fn(), { async: vi.fn((_inst, done) => destroys.push(done)) }),
    sendConnections: vi.fn(() => 1), sendGetTally: vi.fn(), sendAudio: vi.fn(),
  }
  const status = vi.fn()
  const sender = new NdiSender(lib as unknown as NdiLib, 'NDI Test', 720, 30, false, status)
  const image = (value: number) => ({ isEmpty: () => false, getSize: () => ({ width: 32, height: 18 }),
    toBitmap: () => Buffer.alloc(32 * 18 * 4, value) }) as unknown as NativeImage
  sender.start()
  return { sender, sends, destroys, lib, status, image }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('NDI native send ownership', () => {
  it('bounds native work to one call and sends the latest frame after a slow send', async () => {
    const f = fixture()
    vi.advanceTimersByTime(40)
    f.sender.push(f.image(11)); vi.advanceTimersByTime(40)
    expect(f.sends).toHaveLength(1)
    expect(f.lib.sendCreate).toHaveBeenCalledWith(expect.objectContaining({ clock_video: false, clock_audio: false }))
    f.sender.push(f.image(22)); vi.advanceTimersByTime(100)
    f.sender.push(f.image(33)); vi.advanceTimersByTime(100)
    expect(f.sends).toHaveLength(1)
    expect(f.sends[0].frame.p_data[0]).toBe(11)
    f.sends[0].done(null); vi.advanceTimersByTime(40)
    expect(f.sends).toHaveLength(2)
    expect(f.sends[1].frame.p_data[0]).toBe(33)
    f.sends[1].done(null)
    const stop = f.sender.stop(); f.destroys[0](null); await stop
  })

  it('waits for the in-flight send and native destruction before resolving repeated stop', async () => {
    const f = fixture()
    vi.advanceTimersByTime(40); f.sender.push(f.image(7)); vi.advanceTimersByTime(40)
    const stopped = vi.fn()
    const stop = f.sender.stop()
    expect(f.sender.stop()).toBe(stop)
    void stop.then(stopped)
    expect(f.destroys).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(f.sends).toHaveLength(1)
    f.sends[0].done(null)
    expect(f.destroys).toHaveLength(1)
    expect(stopped).not.toHaveBeenCalled()
    f.destroys[0](null); await stop
    expect(stopped).toHaveBeenCalledOnce()
  })

  it('does not destroy a handle synchronously during a pending FFI call on exit', () => {
    const f = fixture()
    vi.advanceTimersByTime(40); f.sender.push(f.image(8)); vi.advanceTimersByTime(40)
    f.sender.destroyNow()
    expect(f.lib.sendDestroy).not.toHaveBeenCalled()
  })
})
