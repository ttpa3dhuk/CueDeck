import type { PlaylistEntry, PlaylistFolder } from './types.js'

export function sanitizePlaylistFolders(raw: unknown): PlaylistFolder[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((v) => {
    if (!v || typeof v.id !== 'string' || !v.id || typeof v.name !== 'string' || !v.name.trim() || seen.has(v.id)) return []
    seen.add(v.id)
    return [{ id: v.id, name: v.name.trim(), collapsed: v.collapsed === true }]
  })
}

/** Keep groups together at their first member's position; retain every media entry. */
export function normalizeFolderPlaylist(entries: PlaylistEntry[], folders: PlaylistFolder[]): PlaylistEntry[] {
  const valid = new Set(folders.map((f) => f.id))
  const cleaned: PlaylistEntry[] = entries.map((entry) => {
    if (!entry.folderId || valid.has(entry.folderId)) return entry
    const { folderId: _folderId, ...rest } = entry
    return rest
  })
  const emitted = new Set<string>()
  return cleaned.flatMap((entry) => {
    if (!entry.folderId) return [entry]
    if (emitted.has(entry.folderId)) return []
    emitted.add(entry.folderId)
    return cleaned.filter((member) => member.folderId === entry.folderId)
  })
}

/** A stale UI reorder may omit newly added entries; never silently discard them. */
export function reorderFolderPlaylist(entries: PlaylistEntry[], ids: string[], folders: PlaylistFolder[]): PlaylistEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const ordered: PlaylistEntry[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const entry = byId.get(id)
    if (!entry || seen.has(id)) continue
    seen.add(id)
    ordered.push(entry)
  }
  ordered.push(...entries.filter((entry) => !seen.has(entry.id)))
  return normalizeFolderPlaylist(ordered, folders)
}

/** Removes organization or playlist entries only; has no filesystem effects. */
export function removePlaylistFolder(entries: PlaylistEntry[], folders: PlaylistFolder[], id: string, removeContents = false): { playlist: PlaylistEntry[]; playlistFolders: PlaylistFolder[]; removed: PlaylistEntry[] } {
  if (!folders.some((folder) => folder.id === id)) return { playlist: entries, playlistFolders: folders, removed: [] }
  const playlistFolders = folders.filter((folder) => folder.id !== id)
  const removed = removeContents ? entries.filter((entry) => entry.folderId === id) : []
  return { playlistFolders, removed, playlist: normalizeFolderPlaylist(removeContents ? entries.filter((entry) => entry.folderId !== id) : entries, playlistFolders) }
}

export function nextPlaylistFolderName(folders: PlaylistFolder[]): string {
  const used = new Set(folders.map((folder) => folder.name.trim()))
  for (let ordinal = 1; ; ordinal++) {
    const number = String(ordinal).padStart(3, '0')
    const name = `Speaker ${number}`
    if (!used.has(name) && !used.has(number)) return name
  }
}

/** Assign selected existing entries atomically; unknown IDs and repeats are harmless. */
export function assignPlaylistFolders(entries: PlaylistEntry[], folders: PlaylistFolder[], ids: string[], folderId: string | null): PlaylistEntry[] {
  if (folderId !== null && !folders.some((folder) => folder.id === folderId)) return entries
  const selected = new Set(ids)
  const moving = entries.filter((entry) => selected.has(entry.id) && entry.folderId !== folderId)
  if (folderId && entries.some((entry) => entry.folderId === folderId)) {
    const movingIds = new Set(moving.map((entry) => entry.id))
    const retained = entries.filter((entry) => !movingIds.has(entry.id))
    const lastTarget = retained.map((entry) => entry.folderId).lastIndexOf(folderId)
    retained.splice(lastTarget + 1, 0, ...moving.map((entry) => ({ ...entry, folderId })))
    return normalizeFolderPlaylist(retained, folders)
  }
  return normalizeFolderPlaylist(entries.map((entry) => {
    if (!selected.has(entry.id)) return entry
    const { folderId: _folderId, ...rest } = entry
    return folderId ? { ...rest, folderId } : rest
  }), folders)
}
