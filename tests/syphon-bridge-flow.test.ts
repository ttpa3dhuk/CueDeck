import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getActiveWindows: vi.fn(() => new Map()),
  acquireGhost: vi.fn(),
  releaseGhost: vi.fn(),
  createHiddenAudienceWindow: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}))
vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../src/main/windows', () => mocks)

import type { NativeImage } from 'electron'
import { SyphonBridge } from '../src/main/syphon-bridge'
import { STATUS_PUBLISHED, STATUS_READY } from '../src/main/syphon-bridge-protocol'

function image(bytes: Buffer, label: string): NativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 16, height: 16 }),
    toBitmap: () => {
      if (label === 'dropped') throw new Error('dropped frame must not be read back')
      return bytes
    },
    resize: () => { throw new Error('unexpected resize') },
  } as unknown as NativeImage
}

function setup() {
  const writes: Array<{ header: Buffer; payload: Buffer }> = []
  const invalidate = vi.fn()
  const helper = {
    writeFrame: vi.fn((header: Buffer, payload: Buffer) => {
      writes.push({ header, payload })
      return true
    }),
    kill: vi.fn(),
    destroyNow: vi.fn(),
  }
  const win = {
    isDestroyed: () => false,
    webContents: { invalidate, isLoading: () => false, once: vi.fn() },
  }
  const bridge = new SyphonBridge()
  ;(bridge as any).helper = helper
  ;(bridge as any).win = win
  ;(bridge as any).gate.markReady()
  return { bridge, helper, win, invalidate, writes }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('real bridge admission/recovery flow', () => {
  it('recovers the final static frame skipped while busy, exactly once', () => {
    const { bridge, helper, invalidate, writes } = setup()
    const first = Buffer.alloc(16 * 16 * 4, 1)
    bridge['onFrame'](image(first, 'first')) // first frame is read back and sent
    expect(writes).toHaveLength(1)

    // Final static change arrives while the helper is still busy. It must be
    // dropped before readback, but remembered as dirty.
    bridge['onFrame'](image(Buffer.alloc(16 * 16 * 4, 2), 'dropped'))
    expect(writes).toHaveLength(1)
    expect(invalidate).not.toHaveBeenCalled()

    bridge['onAck'](helper as any, { status: STATUS_PUBLISHED, frameId: 1, detail: 0 })
    expect(invalidate).toHaveBeenCalledOnce()

    const fresh = Buffer.alloc(16 * 16 * 4, 3)
    bridge['onFrame'](image(fresh, 'fresh')) // the requested fresh composition is sent
    expect(writes).toHaveLength(2)
    expect(writes[1].payload).toEqual(fresh)

    bridge['onAck'](helper as any, { status: STATUS_PUBLISHED, frameId: 2, detail: 0 })
    expect(invalidate).toHaveBeenCalledOnce() // unchanged follow-up does not loop
    bridge.destroyNow()
  })

  it('marks helper ready and requests one initial frame', () => {
    const { bridge, helper, invalidate } = setup()
    bridge['onAck'](helper as any, { status: STATUS_READY, frameId: 0, detail: 0 })
    expect(invalidate).toHaveBeenCalledOnce()
    bridge.destroyNow()
  })
  it('does not release the gate or recovery on a stale ACK', () => {
    const { bridge, helper, invalidate, writes } = setup()
    bridge['onFrame'](image(Buffer.alloc(16 * 16 * 4, 4), 'first'))
    bridge['onAck'](helper as any, { status: STATUS_PUBLISHED, frameId: 99, detail: 0 })
    expect(writes).toHaveLength(1)
    expect(invalidate).not.toHaveBeenCalled()

    bridge['onFrame'](image(Buffer.alloc(16 * 16 * 4, 5), 'dropped'))
    expect(writes).toHaveLength(1)
    bridge['onAck'](helper as any, { status: STATUS_PUBLISHED, frameId: 1, detail: 0 })
    expect(invalidate).toHaveBeenCalledOnce()
    bridge.destroyNow()
  })
  it('kills a helper that never acknowledges and releases the one-frame gate', () => {
    vi.useFakeTimers()
    try {
      const { bridge, helper, writes } = setup()
      bridge['onFrame'](image(Buffer.alloc(16 * 16 * 4, 6), 'first'))
      expect(writes).toHaveLength(1)
      vi.advanceTimersByTime(3000)
      expect(helper.kill).toHaveBeenCalled()
      bridge['onFrame'](image(Buffer.alloc(16 * 16 * 4, 7), 'after-timeout'))
      expect(writes).toHaveLength(1)
      bridge.destroyNow()
    } finally {
      vi.useRealTimers()
    }
  })

})
