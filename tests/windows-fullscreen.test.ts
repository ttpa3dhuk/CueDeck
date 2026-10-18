import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ windows: [] as any[], displayListeners: new Set<(...args: any[]) => void>() }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    options: any
    bounds: any
    destroyed = false
    full: boolean
    handlers = new Map<string, () => void>()
    setFullScreen = vi.fn((value: boolean) => { this.full = value })
    setAlwaysOnTop = vi.fn()
    show = vi.fn()
    showInactive = vi.fn()
    focus = vi.fn()
    removeMenu = vi.fn()
    loadURL = vi.fn()
    loadFile = vi.fn()
    constructor(options: any) { this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; this.full = options.fullscreen; runtime.windows.push(this) }
    once(name: string, callback: () => void) { this.handlers.set(name, callback) }
    isDestroyed() { return this.destroyed }
    isFullScreen() { return this.full }
    getBounds() { return this.bounds }
    setBounds(bounds: any) { this.bounds = bounds }
    destroy() { this.destroyed = true }
    close() { this.destroy() }
  },
  screen: {
    on: (_name: string, callback: (...args: any[]) => void) => runtime.displayListeners.add(callback),
    removeListener: (_name: string, callback: (...args: any[]) => void) => runtime.displayListeners.delete(callback),
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1800, height: 1169 }, workArea: { x: 0, y: 40, width: 1800, height: 1129 } },
      { id: 2, bounds: { x: -1920, y: -36, width: 1920, height: 1080 } },
      { id: 3, bounds: { x: 1800, y: 0, width: 1920, height: 1080 } },
    ],
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1800, height: 1169 }, workArea: { x: 0, y: 40, width: 1800, height: 1129 } }),
    getDisplayMatching: (b: any) => ({ id: b.x < 0 ? 2 : b.x >= 1800 ? 3 : 1 }),
  },
}))
vi.mock('../src/main/state.js', () => ({ store: { registerWindow: vi.fn(), unregisterWindow: vi.fn(), patch: vi.fn() } }))
vi.mock('../src/shared/i18n.js', () => ({ getLang: () => 'ru' }))
const platform = process.platform
let windows: typeof import('../src/main/windows.js')
async function load(os = 'darwin', tile = false) {
  Object.defineProperty(process, 'platform', { value: os })
  vi.stubEnv('PRESENTER_DEV_TILE', tile ? '1' : '')
  vi.resetModules()
  windows = await import('../src/main/windows.js')
}
function ready() { for (const w of runtime.windows) w.handlers.get('ready-to-show')?.() }
beforeEach(() => { runtime.windows = []; runtime.displayListeners.clear() })
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.unstubAllEnvs() })

describe('output displays without macOS fullscreen Spaces', () => {
  it('fills only the assigned Mac display and leaves operator focus and window chrome intact', async () => {
    await load()
    windows.applyLayout('presenter-audience', { operator: 1, audience: 2 })
    ready()
    const [operator, audience] = runtime.windows
    expect(operator.options.frame).toBeUndefined()
    expect(operator.show).toHaveBeenCalledOnce()
    expect(operator.focus).toHaveBeenCalledOnce()
    expect(operator.setAlwaysOnTop).not.toHaveBeenCalled()
    expect(audience.bounds).toEqual({ x: -1920, y: -36, width: 1920, height: 1080 })
    expect(audience.options).toMatchObject({ frame: false, roundedCorners: false, fullscreen: false, fullscreenable: false, resizable: false, movable: false, hasShadow: false, enableLargerThanScreen: true })
    expect(audience.setFullScreen).not.toHaveBeenCalled()
    expect(audience.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(audience.showInactive).toHaveBeenCalledOnce()
  })
  it('reuses full-display Mac outputs when applying the same layout, including two simultaneous outputs', async () => {
    await load()
    const map = { operator: 1, speaker: 3, audience: 2 }
    const first = [...windows.applyLayout('operator-speaker-audience', map).values()]
    ready()
    expect([...windows.applyLayout('operator-speaker-audience', map).values()]).toEqual(first)
    expect(runtime.windows).toHaveLength(3)
    for (const w of runtime.windows.slice(1)) expect(w.setFullScreen).not.toHaveBeenCalled()
  })
  it('restores a normal window when windowed mode is selected, then recreates full-display mode on another display', async () => {
    await load()
    windows.applyLayout('presenter-audience', { operator: 1, audience: 2 })
    ready()
    const full = runtime.windows[1]
    windows.applyLayout('presenter-audience', { operator: 1, audience: 2 }, true)
    expect(full.destroyed).toBe(true)
    const normal = runtime.windows[2]
    expect(normal.options.frame).toBeUndefined()
    expect(normal.options.fullscreen).toBe(false)
    windows.applyLayout('presenter-audience', { operator: 1, audience: 3 })
    ready()
    expect(normal.destroyed).toBe(true)
    expect(runtime.windows[3].bounds.x).toBe(1800)
  })
  it('does not show or modify a stale output after switching to solo before ready-to-show', async () => {
    await load()
    windows.applyLayout('presenter-audience', { operator: 1, audience: 2 })
    const output = runtime.windows[1]
    windows.applyLayout('solo', { operator: 1 })
    ready()
    expect(output.destroyed).toBe(true)
    expect(output.showInactive).not.toHaveBeenCalled()
    expect(output.setAlwaysOnTop).not.toHaveBeenCalled()
  })
  it('keeps native fullscreen on Windows', async () => {
    await load('win32')
    windows.applyLayout('presenter-audience', { operator: 1, audience: 2 })
    ready()
    const output = runtime.windows[1]
    expect(output.options.fullscreen).toBe(true)
    expect(output.options.frame).toBeUndefined()
    expect(output.setFullScreen).toHaveBeenCalledWith(true)
    expect(output.removeMenu).toHaveBeenCalledOnce()
    expect(output.setAlwaysOnTop).not.toHaveBeenCalled()
  })
  it('follows resolution changes only on its output display and removes the listener on close', async () => {
    await load()
    windows.applyLayout('presenter-audience', { operator: 1, audience: 2 })
    ready()
    const output = runtime.windows[1]
    const changed = { x: -1280, y: -36, width: 1280, height: 720 }
    for (const listener of runtime.displayListeners) listener({}, { id: 3, bounds: changed }, ['bounds'])
    expect(output.bounds.width).toBe(1920)
    for (const listener of runtime.displayListeners) listener({}, { id: 2, bounds: changed }, ['workArea'])
    expect(output.bounds.width).toBe(1920)
    for (const listener of runtime.displayListeners) listener({}, { id: 2, bounds: changed }, ['bounds'])
    expect(output.bounds).toEqual(changed)
    output.handlers.get('closed')?.()
    expect(runtime.displayListeners.size).toBe(0)
  })
  it('keeps development tiling windowed on Mac', async () => {
    await load('darwin', true)
    windows.applyLayout('presenter-audience', { operator: 1, audience: 2 })
    ready()
    const output = runtime.windows[1]
    expect(output.options.fullscreen).toBe(false)
    expect(output.options.frame).toBeUndefined()
    expect(output.setAlwaysOnTop).not.toHaveBeenCalled()
    expect(output.setFullScreen).not.toHaveBeenCalled()
  })
})
