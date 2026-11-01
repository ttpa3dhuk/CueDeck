import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []
    options: any
    webContents = { setFrameRate: vi.fn() }
    loadFile = vi.fn().mockResolvedValue(undefined)
    loadURL = vi.fn().mockResolvedValue(undefined)
    on = vi.fn()
    once = vi.fn()
    close = vi.fn()
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 }))
    isFullScreen = vi.fn(() => false)
    setAlwaysOnTop = vi.fn()
    setBounds = vi.fn()
    isDestroyed = vi.fn(() => false)
    constructor(options: any) {
      this.options = options
      MockBrowserWindow.instances.push(this)
    }
  }
  return {
    MockBrowserWindow,
    registerWindow: vi.fn(),
    getState: vi.fn(() => ({ audienceOutputEnabled: true })),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.MockBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: 2, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
    ],
    getDisplayMatching: () => ({ id: 1 }),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn() },
}))
vi.mock('../src/main/state.js', () => ({
  store: {
    registerWindow: mocks.registerWindow,
    get: mocks.getState,
    patch: vi.fn(),
    unregisterWindow: vi.fn(),
  },
}))
vi.mock('../src/main/audience-close-guard.js', () => ({ attachAudienceCloseGuard: vi.fn() }))

import { acquireGhost, applyLayout, createGpuAudienceWindow, createHiddenAudienceWindow, releaseGhost } from '../src/main/windows'
import { clearGpuAudienceGuard, setGpuAudienceGuard } from '../src/main/gpu-audience-arbiter'

beforeEach(() => {
  mocks.MockBrowserWindow.instances = []
  vi.clearAllMocks()
  delete process.env.ELECTRON_RENDERER_URL
})

describe('real GPU audience window factory', () => {
  it('uses the audience renderer, offscreen shared texture, and 1920x1080 physical target at 2x DPI', () => {
    const win = createGpuAudienceWindow(1920, 1080) as any
    expect(win).toBe(mocks.MockBrowserWindow.instances[0])
    expect(win.options.width).toBe(960)
    expect(win.options.height).toBe(540)
    expect(win.options.show).toBe(false)
    expect(win.options.useContentSize).toBe(true)
    expect(win.options.enableLargerThanScreen).toBe(true)
    expect(win.options.webPreferences.offscreen).toEqual({ useSharedTexture: true })
    expect(win.options.webPreferences.preload).toContain('preload/index.cjs')
    expect(win.options.webPreferences.backgroundThrottling).toBe(false)
    expect(win.loadFile).toHaveBeenCalledOnce()
    const [path, options] = win.loadFile.mock.calls[0]
    expect(path).toContain('renderer/audience/index.html')
    expect(path).not.toContain('gpu-test')
    expect(options.search).toContain('role=audience')
    expect(mocks.registerWindow).toHaveBeenCalledWith('audience', win)
  })

  it('never hands a GPU ghost to a normal hidden-audience holder', () => {
    const gpuWin = {
      webContents: {}, isDestroyed: vi.fn(() => false), destroy: vi.fn(), on: vi.fn(),
    }
    const normalWin = {
      webContents: {}, isDestroyed: vi.fn(() => false), destroy: vi.fn(), on: vi.fn(),
    }
    const guard = { stop: vi.fn(() => releaseGhost('audience', 'gpu')) }
    setGpuAudienceGuard(guard)
    const gpu = acquireGhost('audience', 'gpu', () => gpuWin as any, 'gpu-audience')
    expect(gpu).toBe(gpuWin)
    const normal = acquireGhost('audience', 'normal', () => normalWin as any)
    expect(guard.stop).toHaveBeenCalledWith('ghost:normal')
    expect(normal).toBe(normalWin)
    releaseGhost('audience', 'normal')
    clearGpuAudienceGuard(guard)
  })

  it('stops the GPU audience before physical layout creates its audience window', () => {
    const guard = { stop: vi.fn() }
    setGpuAudienceGuard(guard)
    applyLayout('presenter-audience', { operator: 1, audience: 2 })
    expect(guard.stop).toHaveBeenCalledWith('layout')
    applyLayout('solo', { operator: 1 })
    clearGpuAudienceGuard(guard)
  })

  it('destroys a stale GPU ghost instead of returning it if the guard is gone', () => {
    const gpuWin = { webContents: {}, isDestroyed: vi.fn(() => false), destroy: vi.fn(), on: vi.fn() }
    const normalWin = { webContents: {}, isDestroyed: vi.fn(() => false), destroy: vi.fn(), on: vi.fn() }
    acquireGhost('audience', 'stale-gpu', () => gpuWin as any, 'gpu-audience')
    const normal = acquireGhost('audience', 'normal-after-stale', () => normalWin as any)
    expect(normal).toBe(normalWin)
    expect(gpuWin.destroy).toHaveBeenCalled()
    releaseGhost('audience', 'normal-after-stale')
  })

  it('does not reuse the normal hidden-audience factory options', () => {
    const gpu = createGpuAudienceWindow() as any
    expect(gpu.options.transparent).not.toBe(true)
    expect(gpu.options.webPreferences.offscreen).toEqual({ useSharedTexture: true })
    expect(gpu.options.title).toContain('GPU audience')

    const normal = createHiddenAudienceWindow(960, 540) as any
    expect(normal.options.webPreferences.offscreen).toBeUndefined()
    expect(normal.options.title).toBe('CueDeck (hidden audience)')
  })
})
