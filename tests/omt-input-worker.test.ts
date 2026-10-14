import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ retain: vi.fn(), release: vi.fn(), destroy: vi.fn(), discover: vi.fn(), library: vi.fn() }))
vi.mock('../src/main/omt/inputs.js', () => ({ OmtInputManager: class { retain = fake.retain; release = fake.release; destroy = fake.destroy; discover = fake.discover } }))
vi.mock('../src/main/omt/libomt-native.js', () => ({ createOmtLibrary: fake.library }))
class Port extends EventEmitter {
  postMessage = vi.fn(); start = vi.fn(); close = vi.fn()
}
const saved = Object.getOwnPropertyDescriptor(process, 'parentPort')
afterEach(() => { if (saved) Object.defineProperty(process, 'parentPort', saved); else Reflect.deleteProperty(process, 'parentPort') })
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
})
