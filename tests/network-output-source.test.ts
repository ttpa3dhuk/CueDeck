import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  active: new Map<string, any>(), ghosts: new Map<string, any>(), gpu: false,
  frameCallbacks: new Map<any, (image: any) => void>(), leases: [] as Array<{ release: ReturnType<typeof vi.fn> }>,
  audioHandler: undefined as ((event: any, chunk: any) => void) | undefined,
  windows: [] as any[], allow: vi.fn(), releaseGhost: vi.fn(), failTap: false,
}))
vi.mock('electron', () => ({
  ipcMain: { on: (_name: string, fn: typeof m.audioHandler) => { m.audioHandler = fn } },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../src/main/frame-tap.js', () => ({ acquireFrameTap: (wc: any, _holder: string, cb: (image: any) => void) => {
  if (m.failTap) throw new Error('tap failed')
  m.frameCallbacks.set(wc, cb)
  const lease = { release: vi.fn(() => { m.frameCallbacks.delete(wc) }) }
  m.leases.push(lease)
  return lease
} }))
vi.mock('../src/main/gpu-audience-arbiter.js', () => ({ isGpuAudienceActive: () => m.gpu }))
vi.mock('../src/main/stream/streamer.js', () => ({ allowAudienceCapture: m.allow }))
vi.mock('../src/main/windows.js', () => ({
  getActiveWindows: () => m.active,
  ghostWindow: (role: string) => m.ghosts.get(role),
  releaseGhost: (role: string, holder: string) => { m.releaseGhost(role, holder); m.ghosts.delete(role) },
  acquireGhost: (role: string, _holder: string, create: () => any) => {
    if (!m.ghosts.has(role)) m.ghosts.set(role, create())
    return m.ghosts.get(role)
  },
  createHiddenAudienceWindow: () => makeWindow(),
  createHiddenSpeakerWindow: () => makeWindow(),
  createOmtAudioWindow: () => makeWindow(),
}))
function makeWindow() {
  let destroyed = false
  let closed: (() => void) | undefined
  const win = {
    webContents: { invalidate: vi.fn(), isLoading: () => false, once: vi.fn() },
    isDestroyed: () => destroyed,
    getContentSize: () => [1920, 1080], setContentSize: vi.fn(),
    on: (_event: string, fn: () => void) => { closed = fn },
    destroy: vi.fn(() => { destroyed = true; closed?.() }),
  }
  m.windows.push(win)
  return win
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  m.active.clear(); m.ghosts.clear(); m.frameCallbacks.clear(); m.leases.length = 0; m.windows.length = 0
  m.gpu = false; m.failTap = false; m.audioHandler = undefined
  m.allow.mockClear(); m.releaseGhost.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('network output shared capture', () => {
  it('shares a tap, gives a newcomer the latest frame, and tears down after the last release', async () => {
    const { acquireNetworkVideo } = await import('../src/main/network-output-source')
    const first = vi.fn(), second = vi.fn()
    const a = acquireNetworkVideo('audience', 30, first, 1080)
    const win = m.windows[0], image = { frame: 1 }
    m.frameCallbacks.get(win.webContents)!(image)
    const b = acquireNetworkVideo('audience', 60, second, 720)
    expect(m.leases).toHaveLength(1)
    expect(second).toHaveBeenCalledWith(image)
    a.release(); a.release()
    expect(m.leases[0].release).not.toHaveBeenCalled()
    const next = { frame: 2 }
    m.frameCallbacks.get(win.webContents)!(next)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith(next)
    b.release()
    expect(m.leases[0].release).toHaveBeenCalledOnce()
    expect(m.releaseGhost).toHaveBeenCalledWith('audience', 'network-output')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('follows the active audience and GPU ghost as the rendering source changes', async () => {
    const { acquireNetworkVideo } = await import('../src/main/network-output-source')
    const first = makeWindow(), normal = makeWindow(), gpu = makeWindow()
    m.active.set('audience', first)
    const listener = vi.fn(), lease = acquireNetworkVideo('audience', 30, listener, 1080)
    m.frameCallbacks.get(first.webContents)!({ frame: 'old' })
    m.active.set('audience', normal)
    vi.advanceTimersByTime(250)
    expect(m.leases[0].release).toHaveBeenCalledOnce()
    expect(m.frameCallbacks.has(normal.webContents)).toBe(true)
    m.gpu = true; m.ghosts.set('audience', gpu)
    vi.advanceTimersByTime(250)
    expect(m.leases[1].release).toHaveBeenCalledOnce()
    expect(m.frameCallbacks.has(gpu.webContents)).toBe(true)
    m.frameCallbacks.get(gpu.webContents)!({ frame: 'gpu' })
    expect(listener).toHaveBeenLastCalledWith({ frame: 'gpu' })
    lease.release()
  })

  it('cleans up a failed video lease and allows a later retry', async () => {
    const { acquireNetworkVideo } = await import('../src/main/network-output-source')
    m.failTap = true
    expect(() => acquireNetworkVideo('speaker', 30, vi.fn(), 1080)).toThrow('tap failed')
    expect(m.ghosts.has('speaker')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    m.failTap = false
    const retry = acquireNetworkVideo('speaker', 30, vi.fn(), 1080)
    expect(m.leases).toHaveLength(1)
    retry.release()
  })

  it('shares audio independently of video and destroys its capture only after the last audio sink', async () => {
    const { acquireNetworkVideo, acquireProgramAudio } = await import('../src/main/network-output-source')
    const video = acquireNetworkVideo('audience', 30, vi.fn(), 1080)
    const a = vi.fn(), b = vi.fn()
    const stopA = acquireProgramAudio(a), stopB = acquireProgramAudio(b)
    const audioWindow = m.windows[1]
    expect(m.allow).toHaveBeenCalledOnce()
    const chunk = { sampleRate: 48000, channels: 2, frames: 2, data: new Float32Array(4) }
    m.audioHandler!({ sender: {} }, chunk)
    m.audioHandler!({ sender: audioWindow.webContents }, { ...chunk, frames: 3 })
    expect(a).not.toHaveBeenCalled()
    m.audioHandler!({ sender: audioWindow.webContents }, chunk)
    expect(a).not.toHaveBeenCalled()
    vi.advanceTimersByTime(130)
    expect(a).toHaveBeenCalledWith(chunk); expect(b).toHaveBeenCalledWith(chunk)
    video.release()
    expect(audioWindow.destroy).not.toHaveBeenCalled()
    stopA(); stopA()
    expect(audioWindow.destroy).not.toHaveBeenCalled()
    stopB()
    expect(audioWindow.destroy).toHaveBeenCalledOnce()
  })
})
