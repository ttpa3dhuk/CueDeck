import log from 'electron-log/main'
import { store } from './state.js'
import { getRecoveryRun, getRestorePending, getSessionCheckpoint, getStartupSettings, setRecoveryRun, setRestorePending, setStartupSettings } from './display-mapping.js'
import { sessionCheckpoint, startupSettings, type StartupSettings } from '../shared/startup-settings.js'
import { isProjectTransferRunning } from './project-transfer.js'
import { newSession, readLastSession, readSessionBackup, writeNewSession, writeSession, writeSessionBackup } from './session-files.js'

let initialized = false
let armed = false
let suspended = false
let startupDone = false
let persistTimer: ReturnType<typeof setTimeout> | undefined
let autosaveTimer: ReturnType<typeof setInterval> | undefined
let saveProject: (() => Promise<void>) | null = null
let autosaving = false
let restoreFinished: Promise<void> = Promise.resolve()
let finishRestoreWait: (() => void) | undefined

export function assertSessionIdle(): void {
  if (suspended) throw new Error('Session restoration is already in progress')
}

/** Saving or quitting must never capture the half-restored state. */
export async function waitForSessionRestore(): Promise<void> {
  while (suspended) await restoreFinished
}

function releaseSessionRestore(): void {
  suspended = false
  finishRestoreWait?.()
  finishRestoreWait = undefined
}

export function flushSessionCheckpoint(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = undefined
  if (armed && !suspended) {
    try { writeSession(sessionCheckpoint(store.get())) }
    catch (error) {
      log.error('session checkpoint failed', error)
      store.patch({ autosaveError: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function initSessionLifecycle(save: () => Promise<void>): void {
  if (initialized) return
  initialized = true
  saveProject = save
  newSession()
  try { writeNewSession(sessionCheckpoint(store.get())) }
  catch (error) { log.error('new session failed', error); store.patch({ autosaveError: error instanceof Error ? error.message : String(error) }) }
  // The previous active process did not reach a clean exit. Count it once per
  // launch, irrespective of whether the operator used automatic restoration.
  const previous = getRecoveryRun()
  const crashes = previous ? (previous.active ? Math.min(2, Math.max(0, previous.crashes) + 1) : 0)
    : (getRestorePending() ? 1 : 0)
  setRecoveryRun({ active: true, crashes })
  setRestorePending(false) // migrate the former single-crash guard
  store.patch({ startup: getStartupSettings(), recoveryStartup: crashes >= 2 })
  store.onChange((state, patch) => {
    if (suspended) return
    if (!['playlist', 'playlistFolders', 'pdfPath', 'currentPlaylistId', 'currentSlide', 'preview', 'video', 'timer', 'audienceTimer', 'keyVisualPath', 'projectPath'].some(key => key in patch)) return
    // Empty startup/settings updates must never replace the last real session.
    if (['playlist', 'playlistFolders', 'pdfPath', 'preview', 'keyVisualPath', 'projectPath'].some(key => key in patch) &&
      (state.playlist.length || state.playlistFolders.length || state.pdfPath || state.preview.path || state.keyVisualPath || state.projectPath)) armed = true
    if (!armed) return
    if (!persistTimer) persistTimer = setTimeout(flushSessionCheckpoint, 150)
  })
  setInterval(() => {
    const state = store.get()
    if (armed && !suspended && (state.video.playing || state.preview.video.playing || state.timer.running || state.audienceTimer.running)) flushSessionCheckpoint()
  }, 5000).unref()
  scheduleAutosave()
}

export function configureStartup(raw: unknown): StartupSettings {
  const settings = startupSettings({ ...store.get().startup, ...(raw && typeof raw === 'object' ? raw : {}) })
  setStartupSettings(settings)
  store.patch({ startup: settings })
  scheduleAutosave()
  if (!settings.autoTestScreen) store.patch({ testScreen: { ...store.get().testScreen, automatic: false } })
  return settings
}

function scheduleAutosave(): void {
  if (autosaveTimer) clearInterval(autosaveTimer)
  autosaveTimer = undefined
  const minutes = store.get().startup.autosaveMinutes
  if (!minutes) return
  autosaveTimer = setInterval(() => { void autosaveProject() }, minutes * 60_000)
}

export async function autosaveProject(): Promise<void> {
  if (autosaving || suspended || !armed || isProjectTransferRunning() || !saveProject) return
  autosaving = true
  try {
    if (store.get().projectPath) await saveProject()
    else writeSessionBackup(sessionCheckpoint(store.get()))
    store.patch({ autosaveError: null })
  }
  catch (error) {
    log.error('project autosave failed', error)
    store.patch({ autosaveError: error instanceof Error ? error.message : String(error) })
  }
  finally { autosaving = false }
}

/** One attempt per app process; a renderer reload cannot retry a bad file. */
export function shouldRestoreAtStartup(): boolean {
  if (startupDone) return false
  startupDone = true
  return store.get().startup.mode === 'last' && !store.get().recoveryStartup
}

export function beginSessionRestore(backupId?: string): ReturnType<typeof getSessionCheckpoint> {
  assertSessionIdle()
  flushSessionCheckpoint()
  suspended = true
  restoreFinished = new Promise(resolve => { finishRestoreWait = resolve })
  try {
    if (backupId) {
      const backup = readSessionBackup(backupId)
      newSession()
      return backup
    }
    const saved = readLastSession()
    if (saved) return saved
    const legacy = getSessionCheckpoint()
    if (legacy) writeSession(legacy)
    return legacy
  } catch (error) {
    releaseSessionRestore()
    throw error
  }
}
export function finishSessionRestore(success = true): void {
  releaseSessionRestore()
  // Repairs after a partial restore belong to a new session. Keep the original
  // checkpoint intact, including unavailable program/preview paths.
  if (!success) newSession()
  armed = success
}
export function beginEmptyProject(): void {
  assertSessionIdle()
  flushSessionCheckpoint()
  armed = false
  newSession()
}
export function finishEmptyProject(): void {
  try { writeNewSession(sessionCheckpoint(store.get())) }
  catch (error) { log.error('new session failed', error); store.patch({ autosaveError: error instanceof Error ? error.message : String(error) }) }
}
export function finishSessionCleanly(): void {
  flushSessionCheckpoint()
  setRecoveryRun({ active: false, crashes: 0 })
  setRestorePending(false)
}
