import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  busy: false,
  dialog: vi.fn(async () => ({ response: 1 })),
  exit: vi.fn(), relaunch: vi.fn(), flush: vi.fn(async () => {}),
  clean: vi.fn(), shutdown: vi.fn(), goodbye: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  app: { exit: runtime.exit, relaunch: runtime.relaunch },
  BrowserWindow: class {}, dialog: { showMessageBox: runtime.dialog },
  globalShortcut: { unregisterAll: vi.fn() },
}))
vi.mock('../src/main/ipc', () => ({ flushPendingWrites: runtime.flush, saveProject: vi.fn(async () => ({ ok: true })) }))
vi.mock('../src/main/diag', () => ({ markCleanExit: runtime.clean }))
vi.mock('../src/main/remote/companion-push', () => ({ companionGoodbye: runtime.goodbye }))
vi.mock('../src/main/stream/streamer', () => ({ shutdownStream: runtime.shutdown }))
vi.mock('../src/main/project-transfer', () => ({ isProjectTransferRunning: () => runtime.busy }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); runtime.busy = true })
afterEach(() => { runtime.busy = false })

describe('quit during project transfer', () => {
  it('blocks closing and restarting until the transfer completes', async () => {
    const { requestQuit } = await import('../src/main/quit-guard')
    await requestQuit({ relaunch: true })
    expect(runtime.dialog).toHaveBeenCalledOnce()
    expect(runtime.exit).not.toHaveBeenCalled()
    expect(runtime.flush).not.toHaveBeenCalled()
    expect(runtime.shutdown).not.toHaveBeenCalled()
    runtime.busy = false
    await requestQuit()
    expect(runtime.exit).toHaveBeenCalledWith(0)
    expect(runtime.relaunch).not.toHaveBeenCalled()
  })

  it('also blocks the operator window close event', async () => {
    const { attachOperatorCloseGuard } = await import('../src/main/quit-guard')
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
    const window = { on: (name: string, listener: (event: { preventDefault(): void }) => void) => listeners.set(name, listener), isDestroyed: () => false }
    attachOperatorCloseGuard(window as never)
    const preventDefault = vi.fn()
    listeners.get('close')!({ preventDefault })
    await Promise.resolve()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(runtime.dialog).toHaveBeenCalledOnce()
    expect(runtime.exit).not.toHaveBeenCalled()
  })
})
