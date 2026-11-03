import log from 'electron-log/main'
import { store } from './state.js'
import { getRestorePending, getSessionCheckpoint, getStartupSettings, setRestorePending, setSessionCheckpoint, setStartupSettings } from './display-mapping.js'
import { sessionCheckpoint, startupSettings, type StartupSettings } from '../shared/startup-settings.js'
import { isProjectTransferRunning } from './project-transfer.js'
import { t } from '../shared/i18n.js'

let initialized = false
let armed = false
let suspended = false
let startupDone = false
let persistTimer: ReturnType<typeof setTimeout> | undefined
let autosaveTimer: ReturnType<typeof setInterval> | undefined
let saveProject: (() => Promise<void>) | null = null
let autosaving = false

export function flushSessionCheckpoint(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = undefined
  if (armed && !suspended) setSessionCheckpoint(sessionCheckpoint(store.get()))
}

export function initSessionLifecycle(save: () => Promise<void>): void {
  if (initialized) return
  initialized = true
  saveProject = save
  store.patch({ startup: getStartupSettings(), recoveryStartup: getRestorePending() })
  store.onChange((state, patch) => {
    if (suspended) return
    if (!['playlist', 'playlistFolders', 'pdfPath', 'currentPlaylistId', 'currentSlide', 'preview', 'video', 'timer', 'audienceTimer', 'keyVisualPath', 'projectPath'].some(key => key in patch)) return
    // Empty startup/settings updates must never replace the last real session.
    if (['playlist', 'playlistFolders', 'pdfPath', 'preview', 'keyVisualPath'].some(key => key in patch) &&
      (state.playlist.length || state.playlistFolders.length || state.pdfPath || state.preview.path || state.keyVisualPath)) armed = true
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
  if (raw && typeof raw === 'object' && 'autosaveMinutes' in raw && settings.autosaveMinutes > 0 && !store.get().projectPath) {
    throw new Error(t('Сначала сохрани проект в файл'))
  }
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
  if (autosaving || suspended || !armed || !store.get().projectPath || isProjectTransferRunning() || !saveProject) return
  autosaving = true
  try { await saveProject(); store.patch({ autosaveError: null }) }
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

export function beginSessionRestore(): ReturnType<typeof getSessionCheckpoint> {
  flushSessionCheckpoint()
  suspended = true
  // Deliberately remains set until a clean application exit. A crash at any
  // point after restore causes the next launch to stay empty, without retries.
  setRestorePending(true)
  return getSessionCheckpoint()
}
export function finishSessionRestore(success = true): void {
  suspended = false
  armed = success
}
export function beginEmptyProject(): void {
  flushSessionCheckpoint()
  armed = false
}
export function finishSessionCleanly(): void {
  flushSessionCheckpoint()
  setRestorePending(false)
}
