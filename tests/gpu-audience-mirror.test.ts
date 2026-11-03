import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  handler: null as null | ((event: any, result: any) => void),
  released: null as null | (() => void),
  release: vi.fn(),
  send: vi.fn(async () => undefined),
  imported: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { on: (_channel: string, handler: any) => { mock.handler = handler } },
  sharedTexture: {
    importSharedTexture: (options: any) => {
      mock.imported(options)
      mock.released = options.allReferencesReleased
      return { release: mock.release }
    },
    sendSharedTexture: mock.send,
  },
}))
import { GpuAudienceMirror } from '../src/main/gpu-audience-mirror'

const info = {
  codedSize: { width: 1920, height: 1080 }, pixelFormat: 'bgra',
  handle: { ioSurface: Buffer.alloc(8, 1) },
} as any

function windowFixture(id = 101) {
  const callbacks = new Map<string, () => void>()
  const frame = {}
  const wc = { id, mainFrame: frame }
  const win = { webContents: wc, isDestroyed: () => false,
    once: (name: string, callback: () => void) => { callbacks.set(name, callback) } }
  return { win: win as any, wc, frame, callbacks,
    ready: (result = {}) => mock.handler!({ sender: wc, senderFrame: frame }, result) }
}

beforeEach(() => {
  mock.release.mockReset(); mock.imported.mockReset()
  mock.send.mockReset().mockResolvedValue(undefined)
  mock.released = null
})

describe('GPU-only audience display import', () => {
  it('waits for release without failing the native output when layout closes a transfer target', async () => {
    const w = windowFixture(), mirror = new GpuAudienceMirror()
    let rejectTransfer!: (error: Error) => void
    mock.send.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { rejectTransfer = reject }))
    mirror.attach(w.win); w.ready()
    const consuming = mirror.consume(info)
    await new Promise(resolve => setImmediate(resolve))
    mirror.detach()
    rejectTransfer(new Error('renderer closed during layout change'))
    await new Promise(resolve => setImmediate(resolve))
    expect(mock.release).toHaveBeenCalledOnce()
    expect(mirror.stats.released).toBe(0)
    mock.released!()
    await expect(consuming).resolves.toBeUndefined()
    expect(mirror.stats.errors).toBe(0)
  })
  it('keeps the native output running when a not-yet-ready display is detached by layout', async () => {
    const w = windowFixture(), mirror = new GpuAudienceMirror()
    mirror.attach(w.win)
    const consuming = mirror.consume(info)
    mirror.detach()
    await expect(consuming).resolves.toBeUndefined()
    expect(mock.imported).not.toHaveBeenCalled()
  })
  it('holds the source until all transferred VideoFrame references are released', async () => {
    const w = windowFixture(), mirror = new GpuAudienceMirror()
    mirror.attach(w.win); w.ready()
    let completed = false
    const consuming = mirror.consume(info).then(() => { completed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(mock.send).toHaveBeenCalledOnce()
    expect(mock.release).toHaveBeenCalledOnce()
    expect(completed).toBe(false)
    mock.released!()
    await consuming
    expect(completed).toBe(true)
    mirror.detach()
  })

  it('ignores readiness from a different renderer frame', async () => {
    const w = windowFixture(), mirror = new GpuAudienceMirror()
    mirror.attach(w.win)
    const consuming = mirror.consume(info)
    mock.handler!({ sender: w.wc, senderFrame: {} }, {})
    await new Promise(resolve => setImmediate(resolve))
    expect(mock.send).not.toHaveBeenCalled()
    w.ready()
    await new Promise(resolve => setImmediate(resolve))
    mock.released!(); await consuming; mirror.detach()
  })

  it('reports a live GPU failure after readiness and still waits for resource release', async () => {
    const w = windowFixture(), onError = vi.fn(), mirror = new GpuAudienceMirror(onError)
    mirror.attach(w.win); w.ready()
    const consuming = mirror.consume(info)
    const rejected = expect(consuming).rejects.toThrow('device lost')
    await new Promise(resolve => setImmediate(resolve))
    w.ready({ error: 'device lost' } as any)
    expect(onError).toHaveBeenCalledOnce()
    expect(mirror.stats.released).toBe(0)
    mock.released!(); await rejected; mirror.detach()
  })

  it('does not return ownership on a failed transfer until Chromium releases the import', async () => {
    const w = windowFixture(), mirror = new GpuAudienceMirror()
    mirror.attach(w.win); w.ready()
    mock.send.mockRejectedValueOnce(new Error('renderer closed'))
    const consuming = mirror.consume(info)
    const rejected = expect(consuming).rejects.toThrow('renderer closed')
    await new Promise(resolve => setImmediate(resolve))
    expect(mock.release).toHaveBeenCalledOnce()
    expect(mirror.stats.released).toBe(0)
    mock.released!(); await rejected; mirror.detach()
  })
})
