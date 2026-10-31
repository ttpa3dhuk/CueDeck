import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), windows: new Map<string, any>(),
  state: { fileKind: 'video', pdfSha1: 'a', currentSlide: 1, slideMedia: [], layout: 'operator-speaker-audience' } as any,
  change: (() => {}) as () => void }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: Function) => h.handlers.set(name, fn), on: (name: string, fn: Function) => h.handlers.set(name, fn) },
  MessageChannelMain: class { port1 = { close: vi.fn() }; port2 = { close: vi.fn() } },
}))
vi.mock('../src/main/state.js', () => ({ store: {
  get: () => h.state, registeredWindow: (role: string) => { const w=h.windows.get(role);return w&&!w.webContents.dead?w:undefined },
  onChange: (fn: () => void) => { h.change=fn },
} }))
import { expectedProgramVideo, registerProgramMirrorIpc } from '../src/main/program-mirror'
class WC extends EventEmitter {
  mainFrame = {}; dead = false; send = vi.fn(); postMessage = vi.fn()
  constructor(readonly id: number) { super() }
  isDestroyed() { return this.dead }
}
function add(role: string, id: number): WC { const wc=new WC(id);h.windows.set(role,{webContents:wc});return wc }
function register(wc: WC, key: unknown = expectedProgramVideo(), frame=wc.mainFrame) {
  h.handlers.get('program-mirror:register')!({sender:wc,senderFrame:frame},key)
}
beforeEach(() => { h.handlers.clear();h.windows.clear();h.state={fileKind:'video',pdfSha1:'a',currentSlide:1,slideMedia:[],layout:'operator-speaker-audience'};registerProgramMirrorIpc(true) })
describe('program frame routing', () => {
  it('connects only the actual program owner to registered consumers, in either registration order', () => {
    const op=add('operator',1), audience=add('audience',2), speaker=add('speaker',3)
    register(op);register(speaker);expect(op.postMessage).not.toHaveBeenCalled()
    register(audience)
    expect(audience.postMessage).toHaveBeenCalledTimes(2)
    expect(op.postMessage.mock.calls[0][1].mode).toBe('consumer')
    register(op);register(audience);expect(audience.postMessage).toHaveBeenCalledTimes(2)
  })
  it('rejects foreign frames, stale sources and windows outside the registered role set', () => {
    const op=add('operator',1), audience=add('audience',2), foreign=new WC(9)
    register(audience);register(op,'cuedeck-media://stream/program?v=stale');register(op,expectedProgramVideo(),{});register(foreign)
    expect(audience.postMessage).not.toHaveBeenCalled()
    register(op);expect(audience.postMessage).toHaveBeenCalledOnce()
  })
  it('retires old connections before a new file can connect', () => {
    const op=add('operator',1), audience=add('audience',2)
    register(op);register(audience);const old=op.postMessage.mock.calls[0][1].id
    h.state.pdfSha1='b';h.change()
    expect(op.send.mock.calls[0][1].id).toBe(old)
    register(op);expect(op.postMessage).toHaveBeenCalledOnce()
    register(audience);expect(op.postMessage).toHaveBeenCalledTimes(2)
    expect(op.postMessage.mock.calls[1][1].id).not.toBe(old)
  })
  it('does not appoint a silent operator as audio owner after the audience window closes', () => {
    const op=add('operator',1), audience=add('audience',2), speaker=add('speaker',3)
    register(op);register(audience);register(speaker)
    audience.dead=true;audience.emit('destroyed')
    expect(op.postMessage.mock.calls.every(c=>c[1].mode==='consumer')).toBe(true)
    h.state.layout='solo';h.change()
    expect(op.postMessage.mock.calls.every(c=>c[1].mode==='consumer')).toBe(true)
  })
  it('keeps solo native even with registered hidden speaker and audience outputs', () => {
    h.state.layout='solo'
    const op=add('operator',1), audience=add('audience',2), speaker=add('speaker',3)
    register(op);register(audience);register(speaker)
    expect(op.postMessage).not.toHaveBeenCalled()
    expect(audience.postMessage).not.toHaveBeenCalled()
    expect(speaker.postMessage).not.toHaveBeenCalled()
  })
  it('reconnects after owner reload rather than keeping a dead channel', () => {
    const op=add('operator',1), audience=add('audience',2)
    register(op);register(audience);audience.emit('did-start-loading')
    expect(op.send).toHaveBeenCalledOnce()
    register(audience);expect(op.postMessage).toHaveBeenCalledTimes(2)
  })
  it('retires a half-transferred connection when a target closes during setup', () => {
    const op=add('operator',1), audience=add('audience',2)
    op.postMessage.mockImplementationOnce(()=>{throw Error('target closed')})
    register(op);expect(()=>register(audience)).not.toThrow()
    expect(audience.send.mock.calls[0][0]).toBe('program-mirror:reset')
    expect(op.send.mock.calls[0][0]).toBe('program-mirror:reset')
    register(op);expect(op.postMessage).toHaveBeenCalledTimes(2)
  })
})
