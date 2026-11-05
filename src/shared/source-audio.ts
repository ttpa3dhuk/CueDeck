import type { AppState, FrameStepIdentity } from './types.js'

/** One patch keeps the card and both loaded copies of that input in sync. */
export function togglePreviewSourceMute(state: AppState, identity: FrameStepIdentity): Partial<AppState> | null {
  const p = state.preview
  if (!p.path || !identity || identity.path !== p.path || identity.entryId !== p.playlistId || identity.sha1 !== p.sha1) return null
  const entry = state.playlist.find(e => e.id === p.playlistId)
  const sourceMuted = !(entry?.sourceMuted ?? p.sourceMuted ?? false)
  return {
    preview: { ...p, sourceMuted },
    ...(entry ? {
      playlist: state.playlist.map(e => e.id === entry.id ? { ...e, sourceMuted } : e),
      ...(state.currentPlaylistId === entry.id ? { sourceMuted } : {}),
    } : {}),
  }
}
