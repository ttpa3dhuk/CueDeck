import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), quit: undefined as undefined | (() => void), fork: vi.fn(), channel: vi.fn() }))
vi.mock('electron', () => ({ app: { once: (_name: string, callback: () => void) => { fake.quit = callback } }, ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => fake.handlers.set(name, callback) }, utilityProcess: { fork: fake.fork }, MessageChannelMain: class { port1; port2; constructor() { const ports = fake.channel(); this.port1 = ports[0]; this.port2 = ports[1] } } }))
vi.mock('../src/main/omt/libomt.js', () => ({ libDir: () => '/vendor' }))
vi.mock('../src/main/diag.js', () => ({ logsDir: () => '/logs' }))
import { registerOmtInputIpc } from '../src/main/omt/input-ipc'
class Worker extends EventEmitter {
  messages: any[] = []
  kill = vi.fn()
  postMessage(message: any, ports?: any[]): void {
    this.messages.push({ ...message, ports })
    if (message.request) queueMicrotask(() => this.emit('message', { request: message.request, result: message.type === 'discover' ? [{ address: 'HOST (A)', name: 'HOST (A)' }] : null }))
  }
}
class Renderer extends EventEmitter {
  send = vi.fn(); postMessage = vi.fn(); destroyed = false
  constructor(readonly id: number) { super() }
  isDestroyed() { return this.destroyed }
}
const source = 'HOST (A)'
const retain = (wc: Renderer, addresses: unknown) => fake.handlers.get('omt-input:retain')!({ sender: wc }, addresses)
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); fake.handlers.clear(); fake.fork.mockImplementation(() => new Worker()); fake.channel.mockImplementation(() => [{ close: vi.fn() }, { close: vi.fn() }]); registerOmtInputIpc() })
afterEach(() => { fake.quit!(); vi.useRealTimers() })
describe('OMT utility process wiring', () => {
  it('starts lazily and transfers a direct worker/renderer channel without relaying frames', async () => {
    expect(fake.fork).not.toHaveBeenCalled()
    const wc = new Renderer(1)
    const pending = retain(wc, [source, source]); await vi.runAllTicks(); await pending
    const worker = fake.fork.mock.results[0].value as Worker
    expect(fake.fork).toHaveBeenCalledWith(expect.stringContaining('input-worker.js'), ['/vendor', '/logs/omt-input.log'], expect.objectContaining({ allowLoadingUnsignedLibraries: true }))
    expect(worker.messages[0]).toMatchObject({ type: 'connect', consumer: 1, ports: [expect.anything()] })
    expect(wc.postMessage).toHaveBeenCalledWith('omt-input:port', null, [expect.anything()])
    expect(worker.messages[1]).toMatchObject({ type: 'retain', addresses: [source] })
    worker.emit('message', { frame: { data: new Uint8Array(100) } })
    expect(wc.send).not.toHaveBeenCalled()
  })
  it('bounds lifecycle listeners through empty retain and reload', async () => {
    const wc = new Renderer(1)
    for (let i = 0; i < 4; i++) {
      const pending = retain(wc, [source]); await vi.runAllTicks(); await pending
      await retain(wc, [])
      const next = retain(wc, [source]); await vi.runAllTicks(); await next
      wc.emit('did-start-loading')
    }
    expect(wc.listenerCount('destroyed')).toBe(1)
    expect(wc.listenerCount('did-start-loading')).toBe(1)
    const worker = fake.fork.mock.results[0].value as Worker
    expect(worker.messages.filter(m => m.type === 'release')).toHaveLength(8)
    wc.emit('destroyed')
    expect(worker.messages.at(-1)).toMatchObject({ type: 'release', consumer: 1 })
  })
  it('reconnects retained renderers after crash and stops repeated crash restarts', async () => {
    const wc = new Renderer(1)
    const pending = retain(wc, [source]); await vi.runAllTicks(); await pending
    for (let i = 0; i < 4; i++) {
      const worker = fake.fork.mock.results.at(-1)!.value as Worker
      worker.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(fake.fork).toHaveBeenCalledTimes(4)
    expect(wc.postMessage).toHaveBeenCalledTimes(4)
    expect(wc.send).toHaveBeenLastCalledWith('omt-input:error', expect.objectContaining({ addresses: [source], message: expect.stringContaining('repeatedly failed') }))
  })
  it('rejects worker failures and discovery timeout', async () => {
    fake.fork.mockImplementation(() => {
      const worker = new Worker()
      worker.postMessage = message => { if (message.type !== 'discover') queueMicrotask(() => worker.emit('message', { request: message.request, error: 'native load failed' })) }
      return worker
    })
    const rejected = expect(retain(new Renderer(1), [source])).rejects.toThrow('native load failed')
    await vi.runAllTicks(); await rejected
    const discovery = expect(fake.handlers.get('omt-input:discover')!()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(8000); await discovery
  })
  it.each([null, [''], ['http://host:6400'], ['omt://host'], ['omt://host:70000'], Array(33).fill(source)])('rejects invalid endpoint %j without starting native worker', async addresses => {
    await expect(retain(new Renderer(1), addresses)).rejects.toThrow('Invalid OMT sources')
    expect(fake.fork).not.toHaveBeenCalled()
  })
})
