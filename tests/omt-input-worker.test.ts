import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ retain: vi.fn(), release: vi.fn(), destroy: vi.fn(), discover: vi.fn(), library: vi.fn() }))
vi.mock('../src/main/omt/inputs.js', () => ({ OmtInputManager: class { retain = fake.retain; release = fake.release; destroy = fake.destroy; discover = fake.discover } }))
vi.mock('../src/main/omt/libomt-native.js', () => ({ createOmtLibrary: fake.library }))
class Port extends EventEmitter {
  postMessage = vi.fn(); start = vi.fn(); close = vi.fn()
}
const saved = Object.getOwnPropertyDescriptor(process, 'parentPort')
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const priority = vi.hoisted(() => ({ get: vi.fn(() => 10), set: vi.fn() }))
vi.mock('node:os', () => ({ constants: { priority: { PRIORITY_NORMAL: 0 } }, getPriority: priority.get, setPriority: priority.set }))
afterEach(() => {
  if (saved) Object.defineProperty(process, 'parentPort', saved); else Reflect.deleteProperty(process, 'parentPort')
  Object.defineProperty(process, 'platform', savedPlatform)
  vi.useRealTimers()
})
describe('OMT utility worker', () => {
  it('uses transferred ports for frames and ACKs, releases replaced and closed ports, reports native errors', async () => {
    vi.resetModules(); vi.clearAllMocks()
    const parent = new Port()
    Object.defineProperty(process, 'parentPort', { configurable: true, value: parent })
    await import('../src/main/omt/input-worker')
    const first = new Port(), second = new Port()
    const source = 'HOST (A)'
    const command = (data: unknown, ports: Port[] = []) => parent.emit('message', { data, ports })
    command({ type: 'connect', consumer: 1 }, [first])
    command({ type: 'retain', consumer: 1, addresses: [source], request: 1 })
    expect(parent.postMessage).toHaveBeenLastCalledWith({ request: 1, result: null })
    const onFrame = fake.retain.mock.calls[0][2]
    onFrame(source, { type: 'video' }); onFrame(source, { type: 'video' }); onFrame(source, { type: 'video' })
    expect(first.postMessage).toHaveBeenCalledTimes(2)
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    first.emit('message', { data: { type: 'ack', sequence: first.postMessage.mock.calls[0][0].sequence } })
    onFrame(source, { type: 'video' })
    expect(first.postMessage).toHaveBeenCalledTimes(3)
    command({ type: 'connect', consumer: 1 }, [second])
    expect(first.close).toHaveBeenCalledOnce()
    onFrame(source, { type: 'video' })
    expect(first.postMessage).toHaveBeenCalledTimes(3)
    first.emit('close') // An old port cannot release its replacement.
    expect(second.close).not.toHaveBeenCalled()
    command({ type: 'retain', consumer: 1, addresses: [source], request: 2 })
    fake.retain.mock.calls.at(-1)![2](source, { type: 'video' })
    expect(second.postMessage).toHaveBeenCalledOnce()
    second.emit('close')
    expect(second.close).toHaveBeenCalledOnce()
    fake.discover.mockImplementation(() => { throw new Error('native unavailable') })
    command({ type: 'discover', request: 3 })
    expect(parent.postMessage).toHaveBeenLastCalledWith({ request: 3, consumer: undefined, error: 'native unavailable' })
    command({ type: 'shutdown' })
    expect(fake.destroy).toHaveBeenCalledOnce()
  })

  it('reports raw native audio cadence and audio drops per address every 10 s', async () => {
    vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks()
    const parent = new Port()
    Object.defineProperty(process, 'parentPort', { configurable: true, value: parent })
    await import('../src/main/omt/input-worker')
    const source = 'HOST (A)'
    const port = new Port()
    const command = (data: unknown, ports: Port[] = []) => parent.emit('message', { data, ports })
    command({ type: 'connect', consumer: 1 }, [port])
    command({ type: 'retain', consumer: 1, addresses: [source], request: 1 })
    const onFrame = fake.retain.mock.calls[0][2]
    onFrame(source, { type: 'audio' })
    vi.advanceTimersByTime(50)
    onFrame(source, { type: 'audio' })
    vi.advanceTimersByTime(10_000)
    const summaries = () => parent.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'stats')
    expect(summaries()).toHaveLength(1)
    expect(summaries()[0]).toMatchObject({ consumer: 1, address: source, rawFrames: 2, rawMaxGapMs: 50, dropped: 0 })
    // Frames the renderer never acknowledged are counted as audio drops only.
    // The Port stub never ACKs, so the 24-frame window keeps two of the first
    // ones pending and all 26 frames must be accounted for.
    for (let i = 0; i < 26; i++) onFrame(source, { type: 'audio' })
    vi.advanceTimersByTime(10_000)
    expect(summaries()).toHaveLength(2)
    expect(summaries()[1]).toMatchObject({ address: source, rawFrames: 26, dropped: 4 })
    command({ type: 'shutdown' })
  })
  it('restores only a lowered Windows worker priority, without raising Normal or High', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    for (const value of [10, 0, -14]) {
      vi.resetModules(); priority.set.mockClear(); priority.get.mockReturnValue(value)
      const parent = new Port()
      Object.defineProperty(process, 'parentPort', { configurable: true, value: parent })
      await import('../src/main/omt/input-worker')
      expect(priority.set.mock.calls).toEqual(value > 0 ? [[0]] : [])
      parent.emit('message', { data: { type: 'shutdown' }, ports: [] })
    }
  })

  it('keeps receiving when Windows refuses a priority change and leaves macOS alone', async () => {
    vi.resetModules(); priority.set.mockReset(); priority.get.mockReturnValue(10)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    priority.set.mockImplementationOnce(() => { throw new Error('denied') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const parent = new Port()
    Object.defineProperty(process, 'parentPort', { configurable: true, value: parent })
    await import('../src/main/omt/input-worker')
    const connected = new Port()
    parent.emit('message', { data: { type: 'connect', consumer: 2 }, ports: [connected] })
    expect(connected.start).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('[OMT input] could not restore normal process priority:', expect.any(Error))
    parent.emit('message', { data: { type: 'shutdown' }, ports: [] })
    warning.mockRestore()
    vi.resetModules(); priority.set.mockClear(); priority.get.mockClear()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const macParent = new Port()
    Object.defineProperty(process, 'parentPort', { configurable: true, value: macParent })
    await import('../src/main/omt/input-worker')
    expect(priority.get).not.toHaveBeenCalled()
    expect(priority.set).not.toHaveBeenCalled()
    macParent.emit('message', { data: { type: 'shutdown' }, ports: [] })
  })

})
