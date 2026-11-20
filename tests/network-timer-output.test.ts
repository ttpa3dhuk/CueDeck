import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { NetworkTimerOutput } from '../src/main/network-timer-output'
import { store } from '../src/main/state'
import { createTimerOverlayWindow } from '../src/main/windows'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../src/main/windows', () => ({
  createTimerOverlayWindow: vi.fn(() => ({
    destroy: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { setFrameRate: vi.fn(), invalidate: vi.fn() }),
  })),
}))

function sender(size: number, fps: number) {
  return { name: '', size, fps, start: vi.fn(), stop: vi.fn(async () => {}),
    setFps(value: number) { this.fps = value }, push: vi.fn() }
}
it.each(['ndi', 'omt'] as const)('shares, splits and keeps the other timer after stopping %s', async first => {
  const a = sender(720, 25), b = sender(1080, 30)
  const ndi = new NetworkTimerOutput('ndi', a), omt = new NetworkTimerOutput('omt', b)
  const factory = vi.mocked(createTimerOverlayWindow)
  factory.mockClear()
  store.patch({ speakerMessage: null, ndi: { ...store.get().ndi, timerMessage: true },
    omt: { ...store.get().omt, timerMessage: false } })
  omt.start()
  ndi.start()
  expect(factory).toHaveBeenCalledTimes(1)
  const shared = factory.mock.results[0].value
  const paint = (win: typeof shared, image: string) => win.webContents.emit('paint', {}, {}, image)
  paint(shared, 'shared')
  expect(a.push).toHaveBeenLastCalledWith('shared')
  expect(b.push).toHaveBeenLastCalledWith('shared')
  store.patch({ speakerMessage: 'Hello' })
  expect(factory).toHaveBeenLastCalledWith(1280, 720, true)
  const withMessage = factory.mock.results.at(-1)!.value
  paint(withMessage, 'with message')
  paint(shared, 'plain')
  expect(a.push).toHaveBeenLastCalledWith('with message')
  expect(b.push).toHaveBeenLastCalledWith('plain')
  store.patch({ speakerMessage: null })
  expect(withMessage.destroy).toHaveBeenCalledOnce()
  paint(shared, 'back together')
  expect(a.push).toHaveBeenLastCalledWith('back together')
  expect(b.push).toHaveBeenLastCalledWith('back together')
  const [off, survivor, sink] = first === 'ndi' ? [ndi, omt, b] as const : [omt, ndi, a] as const
  await off.stop()
  const remaining = first === 'ndi' ? shared : factory.mock.results.at(-1)!.value
  paint(remaining, 'still running')
  expect(sink.push).toHaveBeenLastCalledWith('still running')
  expect(sink.start).toHaveBeenCalledOnce()
  survivor.setFps(15)
  expect(remaining.webContents.setFrameRate).toHaveBeenLastCalledWith(15)
  await survivor.stop()
  expect(remaining.destroy).toHaveBeenCalledOnce()
  const calls = factory.mock.calls.length
  store.patch({ speakerMessage: 'After shutdown' })
  expect(factory).toHaveBeenCalledTimes(calls)
})
