import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class MockWindow {
    static instances: MockWindow[] = []
    options: any
    webContents = {
      setFrameRate: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      startPainting: vi.fn(),
      invalidate: vi.fn(),
    }
    loadFile = vi.fn().mockResolvedValue(undefined)
    once = vi.fn()
    isDestroyed = vi.fn(() => false)
    destroy = vi.fn()
    constructor(options: any) {
      this.options = options
      MockWindow.instances.push(this)
    }
  }
  return { MockWindow }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: h.MockWindow,
}))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/syphon-gpu-publisher.js', () => ({
  GpuTexturePublisher: class {
    static instances: any[] = []
    options: any
    source: any
    onFatal: any
    start = vi.fn()
    destroyNow = vi.fn()
    constructor(options: any, source: any, onFatal: any) {
      this.options = options
      this.source = source
      this.onFatal = onFatal
      ;(this.constructor as any).instances.push(this)
    }
  },
}))

import { SyphonGpuProbe } from '../src/main/syphon-gpu-probe'
import { GpuTexturePublisher } from '../src/main/syphon-gpu-publisher'

const Publisher = GpuTexturePublisher as unknown as { instances: any[] }

describe('synthetic GPU probe remains test-only', () => {
  it('loads gpu-test/index.html, not the audience renderer', () => {
    h.MockWindow.instances = []
    Publisher.instances = []
    const probe = new SyphonGpuProbe()
    probe.start()
    const win = h.MockWindow.instances[0]
    expect(win.options.webPreferences.offscreen).toEqual({ useSharedTexture: true })
    const [path] = win.loadFile.mock.calls[0]
    expect(path).toContain('gpu-test/index.html')
    expect(path).not.toContain('renderer/audience')
    expect(Publisher.instances).toHaveLength(1)
    expect(Publisher.instances[0].source().webContents).toBe(win.webContents)
    probe.destroyNow()
    expect(Publisher.instances[0].destroyNow).toHaveBeenCalled()
  })
})
