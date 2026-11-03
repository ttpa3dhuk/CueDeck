import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_STARTUP_SETTINGS, sessionCheckpoint, startupSettings } from '../src/shared/startup-settings'
const h = vi.hoisted(() => ({ settings: { mode: 'empty', autoTestScreen: true, autosaveMinutes: 0 } as any,
  saved: undefined as any, pending: false, recovery: undefined as { active: boolean; crashes: number } | undefined, transfer: false, writes: 0 }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('electron-log/main', () => ({ default: { error: vi.fn() } }))
vi.mock('../src/main/session-files', () => ({ newSession: vi.fn(), writeNewSession: vi.fn(), readLastSession: vi.fn(() => h.saved), writeSession: vi.fn((value: unknown) => { h.saved = value; h.writes++ }), writeSessionBackup: vi.fn() }))
vi.mock('../src/main/project-transfer', () => ({ isProjectTransferRunning: () => h.transfer }))
vi.mock('../src/main/display-mapping', () => ({
  getStartupSettings: () => h.settings,
  setStartupSettings: (value: unknown) => { h.settings = value },
  getRecoveryRun: () => h.recovery,
  setRecoveryRun: (value: { active: boolean; crashes: number }) => { h.recovery = value },
  getRestorePending: () => h.pending,
  setRestorePending: (value: boolean) => { h.pending = value },
  getSessionCheckpoint: vi.fn(() => h.saved),
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
  h.settings = { ...DEFAULT_STARTUP_SETTINGS }; h.saved = undefined; h.pending = false; h.recovery = undefined; h.transfer = false; h.writes = 0
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('defaults to an empty startup and accepts only the supported autosave intervals', () => {
  expect(startupSettings(null)).toEqual(DEFAULT_STARTUP_SETTINGS)
  expect(startupSettings({ mode: 'last', autosaveMinutes: 1 })).toMatchObject({ mode: 'last', autosaveMinutes: 0 })
  expect(startupSettings({ autosaveMinutes: 60, autoTestScreen: false })).toMatchObject({ autosaveMinutes: 60, autoTestScreen: false })
})
it('enables autosave without a named project', async () => {
  const { lifecycle } = await boot()
  expect(lifecycle.configureStartup({ autosaveMinutes: 15 }).autosaveMinutes).toBe(15)
  expect(h.settings.autosaveMinutes).toBe(15)
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
it('retries after one crash and blocks automatic restoration after two consecutive crashes', async () => {
  h.settings.mode = 'last'
  let run = await boot()
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(true)
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(false)
  // Process disappears without clean exit, including a crash before restore.
  run = await boot()
  expect(run.store.get().recoveryStartup).toBe(false)
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(true)
  run.lifecycle.beginSessionRestore()
  run = await boot()
  expect(run.store.get().recoveryStartup).toBe(true)
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(false)
  const saved = h.saved
  run.lifecycle.beginSessionRestore(); run.lifecycle.finishSessionRestore(false)
  run.store.patchTimer({ durationMs: 100 })
  run.lifecycle.flushSessionCheckpoint()
  expect(h.saved).toBe(saved)
  run.lifecycle.finishSessionCleanly()
  run = await boot()
  expect(run.store.get().recoveryStartup).toBe(false)
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(true)
})
it('resets the crash count on clean exit and respects empty startup', async () => {
  h.settings.mode = 'last'
  await boot()
  let run = await boot()
  expect(h.recovery?.crashes).toBe(1)
  run.lifecycle.finishSessionCleanly()
  run = await boot()
  expect(h.recovery?.crashes).toBe(0)
  run.lifecycle.finishSessionCleanly()
  h.settings.mode = 'empty'
  run = await boot()
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(false)
})
it('migrates the previous pending marker as one crash, not two', async () => {
  h.settings.mode = 'last'; h.pending = true
  const run = await boot()
  expect(h.pending).toBe(false)
  expect(h.recovery?.crashes).toBe(1)
  expect(run.lifecycle.shouldRestoreAtStartup()).toBe(true)
})
it('writes backups for unnamed sessions, skips transfer and never overlaps named writes', async () => {
  h.settings.autosaveMinutes = 15
  let finish!: () => void
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const { store, lifecycle } = await boot(save)
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(save).not.toHaveBeenCalled()
  store.patch({ playlist: [entry] })
  await lifecycle.autosaveProject()
  expect(save).not.toHaveBeenCalled()
  const { writeSessionBackup } = await import('../src/main/session-files')
  expect(writeSessionBackup).toHaveBeenCalledOnce()
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

it('creates an unnamed checkpoint when the interval elapses', async () => {
  const { store, lifecycle } = await boot()
  const { writeSessionBackup } = await import('../src/main/session-files')
  vi.mocked(writeSessionBackup).mockClear()
  store.patch({ playlist: [entry] })
  lifecycle.configureStartup({ autosaveMinutes: 15 })
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(writeSessionBackup).toHaveBeenCalledOnce()
  expect(vi.mocked(writeSessionBackup).mock.calls[0][0].playlist).toEqual([entry])
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

it('rejects overlapping restores and keeps failed source session intact when repairs begin', async () => {
  const { store, lifecycle } = await boot()
  const { newSession } = await import('../src/main/session-files')
  vi.mocked(newSession).mockClear()
  lifecycle.beginSessionRestore()
  expect(() => lifecycle.beginSessionRestore()).toThrow('already in progress')
  lifecycle.finishSessionRestore(false)
  expect(newSession).toHaveBeenCalledOnce()
  const writes = h.writes
  lifecycle.flushSessionCheckpoint()
  expect(h.writes).toBe(writes)
  store.patch({ playlist: [entry] })
  lifecycle.flushSessionCheckpoint()
  expect(h.writes).toBe(writes + 1)
})

it('blocks New/Open mutation during restore and delays shutdown/save until it finishes', async () => {
  const { store, lifecycle } = await boot()
  lifecycle.beginSessionRestore()
  let finished = false
  const wait = lifecycle.waitForSessionRestore().then(() => { finished = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(() => lifecycle.assertSessionIdle()).toThrow('already in progress')
  expect(() => lifecycle.beginEmptyProject()).toThrow('already in progress')
  store.patch({ playlist: [entry] })
  lifecycle.flushSessionCheckpoint()
  expect(h.writes).toBe(0)
  lifecycle.finishSessionRestore(true)
  await wait
  expect(finished).toBe(true)
  expect(() => lifecycle.assertSessionIdle()).not.toThrow()
  lifecycle.flushSessionCheckpoint()
  expect(h.saved.playlist).toEqual([entry])
})

it('releases shutdown wait after unsuccessful restore without persisting partial state', async () => {
  const { store, lifecycle } = await boot()
  lifecycle.beginSessionRestore()
  store.patch({ playlist: [entry] })
  const wait = lifecycle.waitForSessionRestore()
  lifecycle.finishSessionRestore(false)
  await wait
  lifecycle.flushSessionCheckpoint()
  expect(h.writes).toBe(0)
})


it('migrates a legacy-only checkpoint once and uses the session file on the next launch', async () => {
  let run = await boot()
  const files = await import('../src/main/session-files')
  const settings = await import('../src/main/display-mapping')
  const legacy = sessionCheckpoint(run.store.get())
  legacy.playlist = [entry]
  legacy.program.path = entry.filePath
  legacy.program.slide = 4
  const original = structuredClone(legacy)
  vi.mocked(files.readLastSession).mockReturnValueOnce(undefined)
  vi.mocked(settings.getSessionCheckpoint).mockReturnValueOnce(legacy)
  vi.mocked(files.writeSession).mockClear()
  vi.mocked(settings.getSessionCheckpoint).mockClear()
  expect(run.lifecycle.beginSessionRestore()).toBe(legacy)
  expect(files.writeSession).toHaveBeenCalledExactlyOnceWith(legacy)
  expect(h.saved).toEqual(original)
  expect(settings.getSessionCheckpoint).toHaveBeenCalledOnce()
  run.lifecycle.finishSessionRestore(true)

  // A fresh process must use the migrated service file; reading legacy again
  // could silently replace later edits with the old settings checkpoint.
  run = await boot()
  vi.mocked(settings.getSessionCheckpoint).mockClear()
  expect(run.lifecycle.beginSessionRestore()).toBe(h.saved)
  expect(settings.getSessionCheckpoint).not.toHaveBeenCalled()
  expect(files.writeSession).toHaveBeenCalledOnce()
  expect(h.saved).toEqual(original)
  expect(legacy).toEqual(original)
  run.lifecycle.finishSessionRestore(true)
})

it.each(['Invalid session file', 'ENOENT: missing pointed session file'])(
  'does not replace a broken service session with stale legacy data: %s', async message => {
    const { store, lifecycle } = await boot()
    const files = await import('../src/main/session-files')
    const settings = await import('../src/main/display-mapping')
    const legacy = sessionCheckpoint(store.get())
    legacy.playlist = [entry]
    h.saved = legacy // Legacy data really exists; failure must not read/use it.
    vi.mocked(files.readLastSession).mockImplementationOnce(() => { throw new Error(message) })
    vi.mocked(files.writeSession).mockClear()
    vi.mocked(settings.getSessionCheckpoint).mockClear()
    expect(() => lifecycle.beginSessionRestore()).toThrow(message)
    expect(settings.getSessionCheckpoint).not.toHaveBeenCalled()
    expect(files.writeSession).not.toHaveBeenCalled()
    expect(h.saved).toBe(legacy)
    await lifecycle.waitForSessionRestore()
    expect(() => lifecycle.assertSessionIdle()).not.toThrow()
  },
)
