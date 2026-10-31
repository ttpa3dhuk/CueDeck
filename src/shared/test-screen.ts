import type { AppState, PlaylistEntry } from './types.js'

export interface TestScreenState {
  /** Initially false. Enabled only after inspecting saved startup content. Never persisted. */
  automatic: boolean
  manual: boolean
}
export interface TestScreenInfo {
  role: 'audience' | 'speaker'
  width: number | null
  height: number | null
  refreshRate: number | null
  version: string
}
export const TEST_SCREEN_BRIGHTNESS = 0.8
export const DEFAULT_TEST_SCREEN: TestScreenState = { automatic: false, manual: false }
/** Conservative startup guard: unresolved or missing saved materials still count as content. */
export function startupTestScreenAllowed(saved: {
  playlist: PlaylistEntry[]; lastPath: string | null; projectPath: string | null; keyVisualPath: string | null
}): boolean {
  return saved.playlist.length === 0 && !saved.lastPath && !saved.projectPath && !saved.keyVisualPath
}
export function hasTestScreenContent(state: Pick<AppState, 'playlist' | 'pdfPath' | 'preview' | 'projectPath' | 'keyVisualPath'>): boolean {
  return state.playlist.length > 0 || Boolean(state.pdfPath || state.preview.path || state.projectPath || state.keyVisualPath)
}
export function testScreenVisible(state: AppState): boolean {
  if (state.blackout) return false
  return state.testScreen.manual || (state.testScreen.automatic && !hasTestScreenContent(state))
}
