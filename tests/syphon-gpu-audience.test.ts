import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    layout: 'solo',
    stream: { running: false },
    omt: { enabled: { program: false }, outputs: { program: { state: 'off' } } },
  }
  const listeners = new Set<(s: any) => void>()
  const win = {
    id: 7,
    webContents: {
      isOffscreen: () => true, getType: () => 'offscreen',
      on: vi.fn(), once: vi.fn(), startPainting: vi.fn(), invalidate: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
    once: vi.fn(),
  }
  return {
    state, listeners, win,
    acquireGhost: vi.fn((_role: string, _holder: string, create: () => any) => create()),
    createGpuAudienceWindow: vi.fn(() => win),
    getActiveWindows: vi.fn(() => new Map()),
    ghostWindow: vi.fn(() => null as any),
    releaseGhost: vi.fn(),
  loadGpuAudiencePage: vi.fn(),
    registerWindow: vi.fn(),
    subscribers: [] as Array<(s: any) => void>,
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: class {},
}))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/state.js', () => ({
  store: {
    get: () => h.state,
    registeredWindow: () => undefined,
    onChange: (fn: (s: any) => void) => { h.listeners.add(fn); return () => h.listeners.delete(fn) },
    registerWindow: h.registerWindow,
  },
}))
vi.mock('../src/main/windows.js', () => ({
  acquireGhost: h.acquireGhost,
  createGpuAudienceWindow: h.createGpuAudienceWindow,
  getActiveWindows: h.getActiveWindows,
  ghostWindow: h.ghostWindow,
  releaseGhost: h.releaseGhost,
  loadGpuAudiencePage: h.loadGpuAudiencePage,
}))
vi.mock('../src/main/syphon-gpu-publisher.js', () => ({
  GpuTexturePublisher: class {
    static instances: any[] = []
    options: any
    source: any
    onFatal: any
    start = vi.fn()
    stopAndWait = vi.fn(async () => ({ released: true, timedOut: false }))
    status = vi.fn(() => ({ failed: false, disposed: false, sawTexture: true, missingTexturePaints: 0, inFlight: false, firstTextureAtMs: 10, width: 1920, height: 1080 }))
    constructor(options: any, source: any, onFatal: any) {
      this.options = options
      this.source = source
      this.onFatal = onFatal
      ;(this.constructor as any).instances.push(this)
    }
  },
}))

import { GpuAudienceMode } from '../src/main/syphon-gpu-audience'
import { isGpuAudienceActive, stopGpuAudienceForNormalOutput } from '../src/main/gpu-audience-arbiter'
import { GpuTexturePublisher } from '../src/main/syphon-gpu-publisher'

const Publisher = GpuTexturePublisher as unknown as { instances: any[] }

function reset(): void {
  h.state.layout = 'solo'
  h.state.stream.running = false
  h.state.omt.outputs.program.state = 'off'
  h.state.omt.enabled.program = false
  h.listeners.clear()
  h.acquireGhost.mockClear()
  h.createGpuAudienceWindow.mockClear()
  h.releaseGhost.mockClear()
  h.loadGpuAudiencePage.mockClear()
  h.win.destroy.mockClear()
  h.win.isDestroyed.mockReturnValue(false)
  Publisher.instances = []
  process.env.CUEDECK_SYPHON_GPU_AUDIENCE = '1'
  process.env.CUEDECK_SYPHON_GPU_NATIVE = '/dev/null'
  delete process.env.CUEDECK_SYPHON_GPU
  delete process.env.CUEDECK_SYPHON_BRIDGE
  stopGpuAudienceForNormalOutput('test reset')
}

beforeEach(reset)

describe('GPU audience mode', () => {
  it('uses the single audience ghost, actual audience factory, and explicit 1920x1080 target', async () => {
    const mode = new GpuAudienceMode()
    expect(mode.start()).toEqual({ ok: true })
    expect(h.acquireGhost).toHaveBeenCalledWith('audience', 'gpu-audience', expect.any(Function), 'gpu-audience')
    expect(h.createGpuAudienceWindow).toHaveBeenCalledWith(1920, 1080, false)
    expect(h.releaseGhost).not.toHaveBeenCalled()
    expect(Publisher.instances).toHaveLength(1)
    expect(Publisher.instances[0].options.targetSize).toEqual({ width: 1920, height: 1080 })
    expect(Publisher.instances[0].source().webContents).toBe(h.win.webContents)
    expect(h.loadGpuAudiencePage).toHaveBeenCalledWith(h.win)
    expect(isGpuAudienceActive()).toBe(true)
    expect(mode.status()).toMatchObject({ active: true, target: { width: 1920, height: 1080 }, actual: { width: 1920, height: 1080 } })
    await mode.stop('test')
    expect(Publisher.instances[0].stopAndWait).toHaveBeenCalled()
    expect(h.releaseGhost).toHaveBeenCalledWith('audience', 'gpu-audience')
    expect(isGpuAudienceActive()).toBe(false)
    expect(mode.status().active).toBe(false)
  })

  it('refuses a physical layout, running stream, running OMT program, or existing ghost', () => {
    h.state.layout = 'presenter-audience'
    expect(new GpuAudienceMode().start().ok).toBe(false)
    h.state.layout = 'solo'
    h.state.stream.running = true
    expect(new GpuAudienceMode().start().ok).toBe(false)
    h.state.stream.running = false
    h.state.omt.enabled.program = true
    expect(new GpuAudienceMode().start().ok).toBe(false)
    h.state.omt.enabled.program = false
    h.state.omt.outputs.program.state = 'off'
  h.state.omt.enabled.program = false
    h.ghostWindow.mockReturnValueOnce({ isDestroyed: () => false } as any)
    expect(new GpuAudienceMode().start().ok).toBe(false)
    expect(h.acquireGhost).not.toHaveBeenCalled()
  })

  it('stops before a normal output takes the audience lease, without touching the normal path', () => {
    const mode = new GpuAudienceMode()
    expect(mode.start().ok).toBe(true)
    expect(isGpuAudienceActive()).toBe(true)
    expect(stopGpuAudienceForNormalOutput('stream')).toBe(true)
    expect(Publisher.instances[0].stopAndWait).toHaveBeenCalled()
    expect(h.releaseGhost).toHaveBeenCalledWith('audience', 'gpu-audience')
    expect(isGpuAudienceActive()).toBe(false)
    expect(h.win.destroy).toHaveBeenCalled()
  })

  it('stops on layout/stream/OMT state changes after startup', () => {
    const mode = new GpuAudienceMode()
    expect(mode.start().ok).toBe(true)
    h.state.layout = 'operator-speaker-audience'
    for (const fn of h.listeners) fn(h.state)
    expect(Publisher.instances[0].stopAndWait).toHaveBeenCalled()
    expect(isGpuAudienceActive()).toBe(false)

    reset()
    const streamMode = new GpuAudienceMode()
    expect(streamMode.start().ok).toBe(true)
    h.state.stream.running = true
    for (const fn of h.listeners) fn(h.state)
    expect(Publisher.instances[0].stopAndWait).toHaveBeenCalled()
    expect(isGpuAudienceActive()).toBe(false)

    reset()
    const omtMode = new GpuAudienceMode()
    expect(omtMode.start().ok).toBe(true)
    h.state.omt.enabled.program = true
    for (const fn of h.listeners) fn(h.state)
    expect(Publisher.instances[0].stopAndWait).toHaveBeenCalled()
    expect(isGpuAudienceActive()).toBe(false)
  })
})
