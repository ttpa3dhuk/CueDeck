import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_STARTUP_SETTINGS, sessionCheckpoint, startupSettings } from '../src/shared/startup-settings'
const h = vi.hoisted(() => ({ settings: { mode: 'empty', autoTestScreen: true, autosaveMinutes: 0 } as any,
  saved: undefined as any, pending: false, transfer: false, writes: 0 }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('electron-log/main', () => ({ default: { error: vi.fn() } }))
vi.mock('../src/main/project-transfer', () => ({ isProjectTransferRunning: () => h.transfer }))
vi.mock('../src/main/display-mapping', () => ({
  getStartupSettings: () => h.settings,
  setStartupSettings: (value: unknown) => { h.settings = value },
  getRestorePending: () => h.pending,
  setRestorePending: (value: boolean) => { h.pending = value },
  getSessionCheckpoint: () => h.saved,
  setSessionCheckpoint: (value: unknown) => { h.saved = value; h.writes++ },
}))
const entry = { id: 'deck', filePath: '/deck.pdf', fileName: 'deck.pdf', displayName: '', speakerName: '', kind: 'pdf' as const, durationMs: 0 }
async function boot(save = vi.fn(async () => {})) {
  vi.resetModules()
  const { store } = await import('../src/main/state')
  const lifecycle = await import('../src/main/session-lifecycle')
  lifecycle.initSessionLifecycle(save)
  return { store, lifecycle, save }
}
beforeEach(() => {
  vi.useFakeTimers()
  h.settings = { ...DEFAULT_STARTUP_SETTINGS }; h.saved = undefined; h.pending = false; h.transfer = false; h.writes = 0
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('defaults to an empty startup and accepts only the supported autosave intervals', () => {
  expect(startupSettings(null)).toEqual(DEFAULT_STARTUP_SETTINGS)
  expect(startupSettings({ mode: 'last', autosaveMinutes: 1 })).toMatchObject({ mode: 'last', autosaveMinutes: 0 })
  expect(startupSettings({ autosaveMinutes: 60, autoTestScreen: false })).toMatchObject({ autosaveMinutes: 60, autoTestScreen: false })
})
it('rejects enabling autosave without a project file and leaves preferences unchanged', async () => {
  const { store, lifecycle } = await boot()
  store.patch({ playlist: [entry] })
  expect(() => lifecycle.configureStartup({ autosaveMinutes: 15 })).toThrow()
  expect(store.get().startup.autosaveMinutes).toBe(0)
  expect(h.settings.autosaveMinutes).toBe(0)
  store.patch({ projectPath: '/show.pdpres' })
  expect(lifecycle.configureStartup({ autosaveMinutes: 30 }).autosaveMinutes).toBe(30)
  store.patch({ projectPath: null })
  // Other settings can still change while the remembered interval is inactive.
  expect(lifecycle.configureStartup({ mode: 'last' }).mode).toBe('last')
  expect(lifecycle.configureStartup({ autosaveMinutes: 0 }).autosaveMinutes).toBe(0)
})
it('does not overwrite the previous session during empty startup or after New', async () => {
  const previous = { sentinel: true }; h.saved = previous
  const { store, lifecycle } = await boot()
  store.patch({ timerMode: 'clock' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.saved).toBe(previous)
  store.patch({ playlist: [entry] })
  lifecycle.flushSessionCheckpoint()
  expect(h.saved.playlist).toHaveLength(1)
  lifecycle.beginEmptyProject()
  const before = h.saved
  store.patch({ playlist: [], pdfPath: null, projectPath: null })
  store.patchTimer({ durationMs: 999 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.saved).toBe(before)
})
it('remembers unsaved edits and pauses both video and timer clocks in the checkpoint', async () => {
  const { store, lifecycle } = await boot()
  store.patch({ playlist: [entry], pdfPath: entry.filePath, currentSlide: 4 })
  store.patchVideo({ playing: true, anchorSec: 2, anchorAt: 1000 })
  store.patchTimer({ running: true, elapsedMs: 100, startedAt: 1000 })
  const saved = sessionCheckpoint(store.get(), 4000)
  expect(saved.program.slide).toBe(4)
  expect(saved.program.video).toMatchObject({ playing: false, anchorAt: null, anchorSec: 5 })
  expect(saved.timer).toMatchObject({ running: false, startedAt: null, elapsedMs: 3100 })
  lifecycle.flushSessionCheckpoint()
  expect(h.saved.playlist).toEqual([entry])
  expect(h.saved).not.toHaveProperty('remote')
  expect(h.saved).not.toHaveProperty('stream')
})
it('blocks automatic retry after an interrupted restore, including renderer reloads', async () => {
  h.settings.mode = 'last'
  let run = await boot()
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(true)
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(false)
  run.lifecycle.beginSessionRestore()
  expect(h.pending).toBe(true)
  run = await boot()
  expect(run.store.get().recoveryStartup).toBe(true)
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(false)
  // A deliberate manual restore is possible; a failed attempt preserves data.
  const saved = h.saved
  run.lifecycle.beginSessionRestore(); run.lifecycle.finishSessionRestore(false)
  run.store.patchTimer({ durationMs: 100 })
  run.lifecycle.flushSessionCheckpoint()
  expect(h.saved).toBe(saved)
  run.lifecycle.finishSessionCleanly()
  expect(h.pending).toBe(false)
})
it('autosaves only active named projects, skips transfer and never overlaps writes', async () => {
  h.settings.autosaveMinutes = 15
  let finish!: () => void
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const { store, lifecycle } = await boot(save)
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(save).not.toHaveBeenCalled()
  store.patch({ playlist: [entry] })
  await lifecycle.autosaveProject()
  expect(save).not.toHaveBeenCalled()
  store.patch({ projectPath: '/show.pdpres' })
  h.transfer = true
  await lifecycle.autosaveProject()
  expect(save).not.toHaveBeenCalled()
  h.transfer = false
  const first = lifecycle.autosaveProject()
  await lifecycle.autosaveProject()
  expect(save).toHaveBeenCalledOnce()
  finish(); await first
  lifecycle.configureStartup({ autosaveMinutes: 0 })
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(save).toHaveBeenCalledOnce()
})

it('writes a real named project atomically and keeps manual saves ordered', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { saveProjectFile } = await import('../src/main/project')
  const folder = await mkdtemp(join(tmpdir(), 'cuedeck-autosave-'))
  try {
    const path = join(folder, 'show.pdpres')
    let current: Awaited<ReturnType<typeof boot>>['store']
    const save = vi.fn(async () => {
      const state = current.get()
      await saveProjectFile(path, { playlist: state.playlist, keyVisualPath: null })
    })
    const run = await boot(save); current = run.store
    current.patch({ playlist: [entry], projectPath: path })
    await run.lifecycle.autosaveProject()
    expect(JSON.parse(await readFile(path, 'utf8')).playlist[0].id).toBe('deck')
    await Promise.all([
      saveProjectFile(path, { playlist: [entry], keyVisualPath: null }),
      saveProjectFile(path, { playlist: [{ ...entry, displayName: 'latest edit' }], keyVisualPath: null }),
    ])
    expect(JSON.parse(await readFile(path, 'utf8')).playlist[0].displayName).toBe('latest edit')
  } finally { await rm(folder, { recursive: true, force: true }) }
})
