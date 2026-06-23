import Store from 'electron-store'
import { screen } from 'electron'
import type { DisplayMap, Layout } from './layout.js'
import type { PlaylistEntry, TimerMode, TimerPosition, VideoTakeMode } from './state.js'

interface SavedMapping {
  layout: Layout
  displayMap: DisplayMap
}

interface PersistedShape {
  mappings: Record<string, SavedMapping>
  lastPdfPath: string | null
  lastDurationMs: number
  timerMode: TimerMode
  timerPosition: TimerPosition
  timerScale: number
  videoTakeMode: VideoTakeMode
  notesFontSize: number
  playlist: PlaylistEntry[]
  currentPlaylistId: string | null
  playlistCompact: boolean
  autoAdvance: boolean
  keyVisualPath: string | null
  projectPath: string | null
  audienceWindowed: boolean
  audioOutputId: string | null
}

const STORE_DEFAULTS: PersistedShape = {
  mappings: {},
  lastPdfPath: null,
  lastDurationMs: 30 * 60 * 1000,
  timerMode: 'countdown',
  timerPosition: 'top-right',
  timerScale: 1,
  videoTakeMode: 'play-start',
  notesFontSize: 18,
  playlist: [],
  currentPlaylistId: null,
  playlistCompact: false,
  autoAdvance: false,
  keyVisualPath: null,
  projectPath: null,
  audienceWindowed: false,
  audioOutputId: null,
}

let _store: Store<PersistedShape> | null = null

function store(): Store<PersistedShape> {
  if (!_store) {
    _store = new Store<PersistedShape>({ name: 'cue-deck', defaults: STORE_DEFAULTS })
  }
  return _store
}

function topologyKey(displayIds: number[]): string {
  return [...displayIds].sort((a, b) => a - b).join(',')
}

export function currentTopologyKey(): string {
  return topologyKey(screen.getAllDisplays().map((d) => d.id))
}

export function getSavedMapping(): SavedMapping | null {
  const key = currentTopologyKey()
  const mappings = store().get('mappings')
  return mappings[key] ?? null
}

export function saveMapping(layout: Layout, displayMap: DisplayMap): void {
  const key = currentTopologyKey()
  const mappings = store().get('mappings')
  mappings[key] = { layout, displayMap }
  store().set('mappings', mappings)
}

export function getLastPdfPath(): string | null {
  return store().get('lastPdfPath')
}

export function setLastPdfPath(path: string | null): void {
  store().set('lastPdfPath', path)
}

export function getLastDurationMs(): number {
  return store().get('lastDurationMs')
}

export function setLastDurationMs(ms: number): void {
  store().set('lastDurationMs', ms)
}

export function getTimerMode(): TimerMode {
  return store().get('timerMode')
}

export function setTimerMode(mode: TimerMode): void {
  store().set('timerMode', mode)
}

export function getTimerPosition(): TimerPosition {
  return store().get('timerPosition')
}

export function setTimerPosition(pos: TimerPosition): void {
  store().set('timerPosition', pos)
}

export function getTimerScale(): number {
  return store().get('timerScale')
}

export function setTimerScale(scale: number): void {
  store().set('timerScale', scale)
}

export function getVideoTakeMode(): VideoTakeMode {
  return store().get('videoTakeMode')
}

export function setVideoTakeMode(mode: VideoTakeMode): void {
  store().set('videoTakeMode', mode)
}

export function getNotesFontSize(): number {
  return store().get('notesFontSize')
}

export function setNotesFontSize(px: number): void {
  store().set('notesFontSize', px)
}

export function getPlaylist(): PlaylistEntry[] {
  const raw = store().get('playlist') as unknown[]
  return raw.map((e) => {
    const v = e as Record<string, unknown>
    return {
      id: String(v.id),
      kind: (v.kind as PlaylistEntry['kind']) ?? 'pdf',
      filePath: String(v.filePath ?? v.pdfPath ?? ''),
      fileName: String(v.fileName ?? v.pdfName ?? ''),
      displayName: String(v.displayName ?? ''),
      speakerName: String(v.speakerName ?? ''),
      durationMs: Number(v.durationMs ?? 30 * 60 * 1000),
    }
  })
}

export function setPlaylist(playlist: PlaylistEntry[]): void {
  store().set('playlist', playlist)
}

export function getCurrentPlaylistId(): string | null {
  return store().get('currentPlaylistId')
}

export function setCurrentPlaylistId(id: string | null): void {
  store().set('currentPlaylistId', id)
}

export function getKeyVisualPath(): string | null {
  return store().get('keyVisualPath')
}

export function setKeyVisualPath(path: string | null): void {
  store().set('keyVisualPath', path)
}

export function getProjectPath(): string | null {
  return store().get('projectPath')
}

export function setProjectPath(path: string | null): void {
  store().set('projectPath', path)
}

export function getPlaylistCompact(): boolean {
  return Boolean(store().get('playlistCompact'))
}

export function setPlaylistCompact(value: boolean): void {
  store().set('playlistCompact', value)
}

export function getAutoAdvance(): boolean {
  return Boolean(store().get('autoAdvance'))
}

export function setAutoAdvance(value: boolean): void {
  store().set('autoAdvance', value)
}

export function getAudienceWindowed(): boolean {
  return Boolean(store().get('audienceWindowed'))
}

export function setAudienceWindowed(value: boolean): void {
  store().set('audienceWindowed', value)
}

export function getAudioOutputId(): string | null {
  return store().get('audioOutputId')
}

export function setAudioOutputId(id: string | null): void {
  store().set('audioOutputId', id)
}
