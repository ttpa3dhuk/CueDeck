import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const mocks = vi.hoisted(() => {
  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []
    options: any
    contentSize: number[]
    getContentSize = vi.fn(() => this.contentSize)
    setContentSize = vi.fn((width: number, height: number) => { this.contentSize = [width, height] })
    getSize = vi.fn(() => this.contentSize)
    setSize = vi.fn((width: number, height: number) => {
      if (!mocks.refuseResize) this.contentSize = [width + mocks.resizeRounding[0], height + mocks.resizeRounding[1]]
    })
    webContents = { setFrameRate: vi.fn() }
    loadFile = vi.fn().mockResolvedValue(undefined)
    loadURL = vi.fn().mockResolvedValue(undefined)
    on = vi.fn()
    once = vi.fn()
    close = vi.fn()
    destroy = vi.fn()
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 }))
    isFullScreen = vi.fn(() => false)
    setAlwaysOnTop = vi.fn()
    removeMenu = vi.fn()
    setBounds = vi.fn()
    isDestroyed = vi.fn(() => false)
    constructor(options: any) {
      this.options = options
      this.contentSize = [options.width, Math.min(options.height, mocks.initialHeightLimit)]
      MockBrowserWindow.instances.push(this)
    }
  }
  return {
    MockBrowserWindow,
    displayScale: 2,
    initialHeightLimit: Infinity,
    resizeRounding: [0, 0],
    refuseResize: false,
    registerWindow: vi.fn(),
    unregisterWindow: vi.fn(),
    registeredWindow: vi.fn(() => undefined as any),
    getState: vi.fn(() => ({ audienceOutputEnabled: true, audienceWindowed: false,
      audienceAlwaysOnTop: true, displayMap: { operator: 1, audience: 2 }, layout: 'presenter-audience' })),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.MockBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: mocks.displayScale, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
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
    registeredWindow: mocks.registeredWindow,
    get: mocks.getState,
    patch: vi.fn(),
    unregisterWindow: mocks.unregisterWindow,
  },
}))
vi.mock('../src/main/audience-close-guard.js', () => ({ attachAudienceCloseGuard: vi.fn() }))

import { acquireGhost, applyLayout, createGpuAudienceWindow, createGpuPrompterWindow, createHiddenAudienceWindow, getActiveWindows, reconcileGpuAudienceDisplay, releaseGhost } from '../src/main/windows'
import { clearGpuAudienceGuard, setGpuAudienceGuard } from '../src/main/gpu-audience-arbiter'

beforeEach(() => {
  mocks.displayScale = 2
  mocks.initialHeightLimit = Infinity
  mocks.resizeRounding = [0, 0]
  mocks.refuseResize = false
  mocks.MockBrowserWindow.instances = []
  vi.clearAllMocks()
  delete process.env.ELECTRON_RENDERER_URL
})

describe('real GPU audience window factory', () => {
  it('renders the real prompter without taking the physical speaker registration', () => {
    mocks.initialHeightLimit = 941
    mocks.resizeRounding = [1, 1]
    const win = createGpuPrompterWindow() as any
    expect(win.options.webPreferences.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 1 })
    expect(win.options.thickFrame).toBe(false)
    expect(win.getSize()).toEqual([1920, 1080])
    expect(win.loadFile.mock.calls[0][0]).toContain(join('renderer', 'presenter', 'index.html'))
    expect(win.loadFile.mock.calls[0][1].search).toContain('role=speaker')
    expect(mocks.registerWindow).toHaveBeenCalledExactlyOnceWith('gpu-prompter', win)
  })
  it.each([1, 1.15, 1.25, 1.3, 1.5, 1.75, 2, 2.25, 2.5])('uses a fixed Full HD offscreen texture at desktop scale %s', (scale) => {
    mocks.displayScale = scale
    const win = createGpuAudienceWindow(1920, 1080) as any
    expect(win).toBe(mocks.MockBrowserWindow.instances[0])
    expect(win.options.width).toBe(1920)
    expect(win.options.height).toBe(1080)
    expect(win.options.show).toBe(false)
    expect(win.options.thickFrame).toBe(false)
    expect(win.options.useContentSize).toBe(true)
    expect(win.options.enableLargerThanScreen).toBe(true)
    expect(win.options.webPreferences.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 1 })
    expect(win.webContents.setFrameRate).toHaveBeenCalledWith(30)
    expect(win.options.webPreferences.preload).toContain(join('preload', 'index.cjs'))
    expect(win.options.webPreferences.backgroundThrottling).toBe(false)
    expect(win.loadFile).toHaveBeenCalledOnce()
    const [path, options] = win.loadFile.mock.calls[0]
    expect(path).toContain(join('renderer', 'audience', 'index.html'))
    expect(path).not.toContain('gpu-test')
    expect(options.search).toContain('role=audience')
    expect(mocks.registerWindow).toHaveBeenCalledWith('audience', win)
  })

  it('restores Full HD before loading when Windows clamps initial height to the work area', () => {
    mocks.initialHeightLimit = 1040
    const win = createGpuAudienceWindow() as any
    expect(win.setSize).toHaveBeenCalledWith(1920, 1080)
    expect(win.getContentSize()).toEqual([1920, 1080])
    expect(win.setSize.mock.invocationCallOrder[0]).toBeLessThan(win.loadFile.mock.invocationCallOrder[0])
  })

  it('corrects Windows fractional-DPI round trips before loading the audience renderer', () => {
    mocks.initialHeightLimit = 941
    mocks.resizeRounding = [1, 1]
    const win = createGpuAudienceWindow() as any
    expect(win.setSize.mock.calls).toEqual([[1920, 1080], [1919, 1079]])
    expect(win.getSize()).toEqual([1920, 1080])
    expect(win.setContentSize).not.toHaveBeenCalled()
    expect(win.setSize.mock.invocationCallOrder[1]).toBeLessThan(win.loadFile.mock.invocationCallOrder[0])
  })

  it('destroys a window that cannot reach the target instead of loading a wrong-sized GPU surface', () => {
    mocks.initialHeightLimit = 941
    mocks.refuseResize = true
    expect(() => createGpuAudienceWindow()).toThrow('GPU audience window size 1920x941')
    const win = mocks.MockBrowserWindow.instances[0]
    expect(win.setSize).toHaveBeenCalledTimes(4)
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(win.loadFile).not.toHaveBeenCalled()
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

  it('uses a display-only mirror in physical layout and retains the GPU producer through solo', () => {
    const guard = { stop: vi.fn(), attachPhysical: vi.fn() }
    setGpuAudienceGuard(guard)
    const physical = applyLayout('presenter-audience', { operator: 1, audience: 2 }).get('audience') as any
    expect(physical.loadFile.mock.calls[0][0]).toContain(join('renderer', 'gpu-view', 'index.html'))
    expect(guard.attachPhysical).toHaveBeenCalledWith(physical)
    expect(mocks.registerWindow).not.toHaveBeenCalledWith('audience', physical)
    expect(guard.stop).not.toHaveBeenCalled()
    applyLayout('solo', { operator: 1 })
    expect(getActiveWindows().has('audience')).toBe(false)
    expect(guard.stop).not.toHaveBeenCalled()
    const reopened = applyLayout('presenter-audience', { operator: 1, audience: 2 }).get('audience') as any
    expect(reopened.loadFile.mock.calls[0][0]).toContain(join('renderer', 'gpu-view', 'index.html'))
    clearGpuAudienceGuard(guard)
    applyLayout('solo', { operator: 1 })
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
    expect(gpu.options.webPreferences.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 1 })
    expect(gpu.options.title).toContain('GPU audience')

    const normal = createHiddenAudienceWindow(960, 540) as any
    expect(normal.options.webPreferences.offscreen).toBeUndefined()
    expect(normal.options.title).toBe('CueDeck (hidden audience)')
  })

  it('replaces an existing physical audience with mirror then restores the normal renderer', () => {
    const normal = applyLayout('presenter-audience', { operator: 1, audience: 2 }).get('audience') as any
    expect(normal.loadFile.mock.calls[0][0]).toContain(join('renderer', 'audience', 'index.html'))
    const guard = { stop: vi.fn(), attachPhysical: vi.fn() }
    setGpuAudienceGuard(guard)
    reconcileGpuAudienceDisplay()
    const mirror = getActiveWindows().get('audience') as any
    expect(normal.destroy).toHaveBeenCalledOnce()
    expect(mirror).not.toBe(normal)
    expect(mirror.loadFile.mock.calls[0][0]).toContain(join('renderer', 'gpu-view', 'index.html'))
    expect(mocks.registerWindow).not.toHaveBeenCalledWith('audience', mirror)
    clearGpuAudienceGuard(guard)
    reconcileGpuAudienceDisplay()
    const restored = getActiveWindows().get('audience') as any
    expect(mirror.destroy).toHaveBeenCalledOnce()
    expect(restored.loadFile.mock.calls[0][0]).toContain(join('renderer', 'audience', 'index.html'))
    expect(mocks.registerWindow).toHaveBeenCalledWith('audience', restored)
    applyLayout('solo', { operator: 1 })
  })

  it('keeps the OSR audience registered while replacing and closing physical mirrors', () => {
    const source = { id: 999 }
    mocks.registeredWindow.mockReturnValue(source)
    const guard = { stop: vi.fn(), attachPhysical: vi.fn() }
    setGpuAudienceGuard(guard)
    const first = applyLayout('presenter-audience', { operator: 1, audience: 2 }, true).get('audience') as any
    const second = applyLayout('presenter-audience', { operator: 1, audience: 2 }, false).get('audience') as any
    expect(second).not.toBe(first)
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(mocks.registerWindow).not.toHaveBeenCalledWith('audience', first)
    expect(mocks.registerWindow).not.toHaveBeenCalledWith('audience', second)
    applyLayout('solo', { operator: 1 })
    expect(mocks.registeredWindow()).toBe(source)
    expect(mocks.unregisterWindow).not.toHaveBeenCalledWith('audience')
    expect(mocks.registerWindow).not.toHaveBeenCalledWith('audience', expect.anything())
    clearGpuAudienceGuard(guard)
    mocks.registeredWindow.mockReturnValue(undefined)
  })
})
