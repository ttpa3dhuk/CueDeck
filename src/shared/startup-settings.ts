import type { AppState, TimerState, VideoState } from './types.js'

export interface StartupSettings {
  mode: 'empty' | 'last'
  autoTestScreen: boolean
  autosaveMinutes: 0 | 15 | 30 | 60
}
export const DEFAULT_STARTUP_SETTINGS: StartupSettings = { mode: 'empty', autoTestScreen: true, autosaveMinutes: 0 }
export function startupSettings(raw: unknown): StartupSettings {
  const v = raw && typeof raw === 'object' ? raw as Partial<StartupSettings> : {}
  return { mode: v.mode === 'last' ? 'last' : 'empty', autoTestScreen: v.autoTestScreen !== false,
    autosaveMinutes: v.autosaveMinutes === 15 || v.autosaveMinutes === 30 || v.autosaveMinutes === 60 ? v.autosaveMinutes : 0 }
}
export interface SessionCheckpoint {
  playlist: AppState['playlist']
  playlistFolders: AppState['playlistFolders']
  keyVisualPath: string | null
  projectPath: string | null
  program: { path: string | null; playlistId: string | null; slide: number; video: VideoState }
  preview: { path: string | null; playlistId: string | null; slide: number; video: VideoState }
  timer: TimerState
  audienceTimer: AppState['audienceTimer']
}
function pausedTimer(timer: TimerState, now: number): TimerState {
  return { ...timer, elapsedMs: timer.elapsedMs + (timer.running && timer.startedAt !== null ? Math.max(0, now - timer.startedAt) : 0),
    running: false, startedAt: null }
}
function pausedVideo(video: VideoState, now: number): VideoState {
  return { ...video, anchorSec: video.anchorSec + (video.playing && video.anchorAt !== null ? Math.max(0, now - video.anchorAt) / 1000 : 0),
    playing: false, anchorAt: null }
}
export function sessionCheckpoint(state: AppState, now = Date.now()): SessionCheckpoint {
  return {
    playlist: state.playlist, playlistFolders: state.playlistFolders,
    keyVisualPath: state.keyVisualPath, projectPath: state.projectPath,
    program: { path: state.pdfPath, playlistId: state.currentPlaylistId, slide: state.currentSlide, video: pausedVideo(state.video, now) },
    preview: { path: state.preview.path, playlistId: state.preview.playlistId, slide: state.preview.currentSlide, video: pausedVideo(state.preview.video, now) },
    timer: pausedTimer(state.timer, now), audienceTimer: { ...state.audienceTimer, ...pausedTimer(state.audienceTimer, now) },
  }
}
