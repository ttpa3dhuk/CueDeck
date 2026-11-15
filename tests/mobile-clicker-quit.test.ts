import { expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ order: [] as string[], release: null as (() => void) | null }))
vi.mock('electron', () => ({
  app: { exit: () => calls.order.push('exit'), relaunch: vi.fn() },
  BrowserWindow: class {}, dialog: {}, globalShortcut: { unregisterAll: vi.fn() },
}))
vi.mock('../src/main/ipc.js', () => ({
  saveProject: vi.fn(), flushPendingWrites: async () => {},
  stopMobileClicker: () => new Promise<void>(resolve => {
    calls.order.push('stopping-clicker')
    calls.release = () => { calls.order.push('clicker-stopped'); resolve() }
  }),
}))
vi.mock('../src/main/remote/companion-push.js', () => ({ companionGoodbye: async () => {} }))
vi.mock('../src/main/stream/streamer.js', () => ({ shutdownStream: vi.fn() }))
vi.mock('../src/main/diag.js', () => ({ markCleanExit: vi.fn() }))
vi.mock('../src/main/session-lifecycle.js', () => ({ finishSessionCleanly: vi.fn() }))
vi.mock('../src/main/project-transfer.js', () => ({ isProjectTransferRunning: () => false }))
vi.mock('../src/main/presentation-preparation.js', () => ({ stopPresentationPreparations: async () => {} }))
vi.mock('../src/main/shared-pdf.js', () => ({ stopSharedPdfFrames: vi.fn() }))
import { requestQuit } from '../src/main/quit-guard'

it('waits for mobile clicker shutdown before the normal app.exit path', async () => {
  const closing = requestQuit()
  for (let n = 0; n < 20; n++) await Promise.resolve()
  expect(calls.order).toEqual(['stopping-clicker'])
  calls.release!()
  await closing
  expect(calls.order).toEqual(['stopping-clicker', 'clicker-stopped', 'exit'])
})
