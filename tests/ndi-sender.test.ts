import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import { NDI_FOURCC_BGRA, type NdiLib } from '../src/main/ndi/libndi-native'
import { NdiSender } from '../src/main/ndi/sender'
import { ProgramVideoTimeline } from '../src/main/program-playout'
import log from 'electron-log/main'
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))

function fixture(alpha = false) {
  const sends: Array<{ frame: any; done: (error: Error | null) => void }> = []
  const destroys: Array<(error: Error | null) => void> = []
  const lib = {
    sendCreate: vi.fn(() => ({ instance: 1 })),
    sendVideoAsync: { async: vi.fn((_inst, frame, done) => sends.push({ frame, done })) },
    sendDestroy: Object.assign(vi.fn(), { async: vi.fn((_inst, done) => destroys.push(done)) }),
    sendConnections: vi.fn(() => 1), sendGetTally: vi.fn(), sendAudio: vi.fn(),
  }
  const status = vi.fn()
  const sender = new NdiSender(lib as unknown as NdiLib, 'NDI Test', 720, 30, alpha, status)
  const image = (value: number) => ({ isEmpty: () => false, getSize: () => ({ width: 32, height: 18 }),
    toBitmap: () => Buffer.alloc(32 * 18 * 4, value) }) as unknown as NativeImage
  sender.start()
  return { sender, sends, destroys, lib, status, image }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('NDI native send ownership', () => {
  it('logs accepted source captures even when native output is busy', async () => {
    vi.mocked(log.info).mockClear()
    const f = fixture(), timeline = new ProgramVideoTimeline()
    f.sender.setProgramCursor(timeline.consumer())
    for (let id = 0; id < 30; id++) {
      timeline.push(f.image(id), performance.now())
      vi.advanceTimersByTime(333)
    }
    vi.advanceTimersByTime(400)
    const row = vi.mocked(log.info).mock.calls.map(([message]) => String(message))
      .find(message => message.includes('кадров от источника'))
    expect(row).toMatch(/кадров от источника [1-9]/)
    f.sends[0]?.done(null)
    const stop = f.sender.stop(); f.destroys[0](null); await stop
  })

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
    const format = Buffer.alloc(4)
    format.writeUInt32LE(f.sends[0].frame.FourCC)
    expect(format.toString('ascii')).toBe('BGRX')
    f.sends[0].done(null); vi.advanceTimersByTime(40)
    expect(f.sends).toHaveLength(2)
    expect(f.sends[1].frame.p_data[0]).toBe(33)
    f.sends[1].done(null)
    const stop = f.sender.stop(); f.destroys[0](null); await stop
  })

  it('converts the timer bitmap to straight alpha without changing the source', async () => {
    const f = fixture(true)
    const bitmap = Buffer.alloc(32 * 18 * 4)
    bitmap.set([32, 64, 128, 128])
    f.sender.push({
      isEmpty: () => false,
      getSize: () => ({ width: 32, height: 18 }),
      toBitmap: () => bitmap,
    } as unknown as NativeImage)
    vi.advanceTimersByTime(40)
    expect(f.sends[0].frame.FourCC).toBe(NDI_FOURCC_BGRA)
    expect([...f.sends[0].frame.p_data.subarray(0, 4)]).toEqual([64, 128, 255, 128])
    expect([...bitmap.subarray(0, 4)]).toEqual([32, 64, 128, 128])
    f.sends[0].done(null)
    const stop = f.sender.stop()
    f.destroys[0](null)
    await stop
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

  it('keeps a static heartbeat through a mute-like cut with no new paint', async () => {
    const f = fixture()
    const timeline = new ProgramVideoTimeline()
    f.sender.setProgramCursor(timeline.consumer())
    timeline.push(f.image(7), performance.now())
    vi.advanceTimersByTime(110)
    expect(f.sends).toHaveLength(1)
    f.sends[0].done(null)
    timeline.markCut(performance.now())
    vi.advanceTimersByTime(40)
    expect(f.sends[1].frame.p_data[0]).toBe(7)
    f.sends[1].done(null)
    vi.advanceTimersByTime(120)
    expect(f.sends.at(-1)!.frame.p_data[0]).toBe(7)
    f.sends.at(-1)!.done(null)
    const stop = f.sender.stop(); f.destroys[0](null); await stop
  })
})
