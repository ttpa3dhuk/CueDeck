import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeFolderPlaylist, reorderFolderPlaylist, insertPlaylistEntries, removePlaylistFolder, nextPlaylistFolderName, assignPlaylistFolders, sanitizePlaylistFolders, duplicatePlaylistEntry } from '../src/shared/playlist-folders'
import { loadProjectFile, saveProjectFile } from '../src/main/project'
import type { PlaylistEntry } from '../src/shared/types'
const entry = (id: string, folderId?: string): PlaylistEntry => ({ id, folderId, kind: 'pdf', filePath: `/media/${id}.pdf`, fileName: `${id}.pdf`, displayName: '', speakerName: '', durationMs: 1000 })
const folders = [{ id: 'a', name: 'Андрей', collapsed: true }, { id: 'b', name: 'Мария' }]
describe('organizational folders', () => {
  it('inserts an ordered external batch above, below and into an empty playlist', () => {
    const old = [entry('one'), entry('two')]
    const batch = [entry('new1'), entry('new2')]
    expect(insertPlaylistEntries(old, batch, [], { beforeId: 'one' }).map((e) => e.id)).toEqual(['new1', 'new2', 'one', 'two'])
    expect(insertPlaylistEntries(old, batch, [], { beforeId: 'two' }).map((e) => e.id)).toEqual(['one', 'new1', 'new2', 'two'])
    expect(insertPlaylistEntries(old, batch, [], { beforeId: null }).map((e) => e.id)).toEqual(['one', 'two', 'new1', 'new2'])
    expect(insertPlaylistEntries([], batch, [], { beforeId: null }).map((e) => e.id)).toEqual(['new1', 'new2'])
    expect(old.map((e) => e.id)).toEqual(['one', 'two'])
  })
  it('places a batch inside a folder and keeps the existing group contiguous', () => {
    const old = [entry('outside'), entry('a1', 'a'), entry('a2', 'a'), entry('after')]
    const batch = [entry('new1'), entry('new2')]
    const inside = insertPlaylistEntries(old, batch, folders, { beforeId: 'a2', folderId: 'a' })
    expect(inside.map((e) => e.id)).toEqual(['outside', 'a1', 'new1', 'new2', 'a2', 'after'])
    expect(inside.slice(2, 4).map((e) => e.folderId)).toEqual(['a', 'a'])
    const end = insertPlaylistEntries(old, batch, folders, { beforeId: 'after', folderId: 'a' })
    expect(end.map((e) => e.id)).toEqual(['outside', 'a1', 'a2', 'new1', 'new2', 'after'])
    const start = insertPlaylistEntries(old, batch, folders, { beforeId: 'a1', folderId: 'a' })
    expect(start.map((e) => e.id)).toEqual(['outside', 'new1', 'new2', 'a1', 'a2', 'after'])
    const emptyGroup = insertPlaylistEntries(old, batch, [...folders, { id: 'empty', name: 'Empty' }], { beforeId: null, folderId: 'empty' })
    expect(emptyGroup.slice(-2).map((e) => e.folderId)).toEqual(['empty', 'empty'])
  })
  it('preserves legacy append and old order when batch or anchor is invalid', () => {
    const old = [entry('a1', 'a'), entry('a2', 'a'), entry('last')]
    expect(insertPlaylistEntries(old, [], folders, { beforeId: 'a2' })).toBe(old)
    expect(insertPlaylistEntries(old, [entry('new')], folders).map((e) => e.id)).toEqual(['a1', 'a2', 'last', 'new'])
    const stale = insertPlaylistEntries(old, [entry('new')], folders, { beforeId: 'removed', folderId: 'a' })
    expect(stale.map((e) => e.id)).toEqual(['a1', 'a2', 'last', 'new'])
    expect(stale[3].folderId).toBeUndefined()
    const invalidFolder = insertPlaylistEntries(old, [entry('new')], folders, { beforeId: 'last', folderId: 'removed' })
    expect(invalidFolder.map((e) => e.id)).toEqual(['a1', 'a2', 'new', 'last'])
    expect(invalidFolder[2].folderId).toBeUndefined()
    expect(old.map((e) => e.id)).toEqual(['a1', 'a2', 'last'])
  })
  it('duplicates a list after its source with independent nested items and identical settings', () => {
    const original: PlaylistEntry = {
      ...entry('1', 'a'), kind: 'list', filePath: '', fileName: 'Photos', displayName: 'Break',
      speakerName: 'After lunch', durationMs: 45000, photoSec: 7, listMode: 'shuffle',
      fadeMs: 350, loop: true,
      items: [{ path: '/media/photo.png', fileName: 'photo.png', kind: 'image' }],
    }
    const input = [entry('before'), original, entry('after', 'a')]
    const result = duplicatePlaylistEntry(input, '1', 'copy')
    expect(result.map((item) => item.id)).toEqual(['before', '1', 'copy', 'after'])
    expect(result[2]).toEqual({ ...original, id: 'copy' })
    expect(result[2]).not.toBe(original)
    expect(result[2].items).not.toBe(original.items)
    expect(result[2].items?.[0]).not.toBe(original.items?.[0])
    result[2].items![0].fileName = 'changed.png'
    expect(original.items?.[0].fileName).toBe('photo.png')
    expect(input.map((item) => item.id)).toEqual(['before', '1', 'after'])
    expect(duplicatePlaylistEntry(input, 'missing', 'copy')).toBe(input)
    expect(duplicatePlaylistEntry(input, '1', 'after')).toBe(input)
  })
  it('groups at the first member, retaining ungrouped entries and all media', () => {
    const input = [entry('1', 'a'), entry('2'), entry('3', 'b'), entry('4', 'a'), entry('5', 'b')]
    const normalized = normalizeFolderPlaylist(input, folders)
    expect(normalized.map((e) => e.id)).toEqual(['1', '4', '2', '3', '5'])
    expect(normalized.every((e) => input.includes(e))).toBe(true)
  })
  it('removing a folder preserves content and only removes its membership', () => {
    const input = [entry('1', 'a'), entry('2', 'b')]
    const normalized = normalizeFolderPlaylist(input, [folders[1]])
    expect(normalized[0]).toEqual({ ...input[0], folderId: undefined })
    expect(normalized[0]).not.toHaveProperty('folderId')
    expect(normalized[1]).toBe(input[1])
    expect(input[0].folderId).toBe('a')
  })
  it('stale reorder keeps omitted entries, ignores unknown and repeated IDs', () => {
    const input = [entry('1', 'a'), entry('2'), entry('3', 'a'), entry('new')]
    expect(reorderFolderPlaylist(input, ['2', '1', '1', 'gone'], folders).map((e) => e.id)).toEqual(['2', '1', '3', 'new'])
  })
  it('defaults to ungrouping and deletes only selected folder entries when explicitly requested', () => {
    const input = [entry('1', 'a'), entry('2', 'b'), entry('3')]
    const safe = removePlaylistFolder(input, folders, 'a')
    expect(safe.playlist.map((e) => e.id)).toEqual(['1', '2', '3'])
    expect(safe.removed).toEqual([])
    expect(safe.playlist[0]).not.toHaveProperty('folderId')
    const remove = removePlaylistFolder(input, folders, 'a', true)
    expect(remove.playlist.map((e) => e.id)).toEqual(['2', '3'])
    expect(remove.removed).toEqual([input[0]])
    expect(remove.playlistFolders).toEqual([folders[1]])
    expect(input[0].filePath).toBe('/media/1.pdf')
    expect(removePlaylistFolder(input, folders, 'unknown', true).playlist).toBe(input)
  })
  it('generates the smallest free numeric name without colliding with existing names', () => {
    expect(nextPlaylistFolderName([])).toBe('Speaker 001')
    expect(nextPlaylistFolderName([{ id: '1', name: '001' }, { id: '3', name: '003' }, { id: 'a', name: 'Андрей' }])).toBe('Speaker 002')
    expect(nextPlaylistFolderName([{ id: '1', name: 'Speaker 001' }, { id: '2', name: 'Speaker 002' }])).toBe('Speaker 003')
  })
  it('moves a selection across folders once, preserves relative order, ignores duplicate/unknown IDs', () => {
    const input = [entry('1', 'a'), entry('2'), entry('3', 'b'), entry('4', 'a'), entry('5', 'b')]
    const result = assignPlaylistFolders(input, folders, ['4', '2', '3', '3', 'unknown'], 'b')
    expect(result.map((e) => e.id)).toEqual(['1', '3', '5', '2', '4'])
    expect(result.filter((e) => e.folderId === 'b').map((e) => e.id)).toEqual(['3', '5', '2', '4'])
    expect(input[1].folderId).toBeUndefined()
    expect(assignPlaylistFolders(input, folders, ['1'], 'invalid')).toBe(input)
    expect(assignPlaylistFolders(result, folders, ['2', '4'], null).filter((e) => !e.folderId).map((e) => e.id)).toEqual(['2', '4'])
  })
  it('places a new group at first selected entry while preserving unselected order', () => {
    const input = [entry('1'), entry('2'), entry('3'), entry('4')]
    const result = assignPlaylistFolders(input, folders, ['4', '2'], 'a')
    expect(result.map((e) => e.id)).toEqual(['1', '2', '4', '3'])
    expect(result.filter((e) => e.folderId === 'a').map((e) => e.id)).toEqual(['2', '4'])
  })
  it('rejects malformed/duplicate folder records and strips nesting', () => {
    expect(sanitizePlaylistFolders([null, { id: 'a', name: '  Андрей ', parentId: 'b' }, { id: 'a', name: 'dup' }, { id: 'b', name: '' }])).toEqual([{ id: 'a', name: 'Андрей', collapsed: false }])
  })
  it('roundtrips names, empty folders, collapsed state and membership; loads legacy projects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuedeck-folders-'))
    try {
      const path = join(dir, 'test.pdpres')
      await saveProjectFile(path, { playlist: [entry('1', 'a')], playlistFolders: folders, keyVisualPath: null })
      const loaded = await loadProjectFile(path)
      expect(loaded.playlistFolders).toEqual([{ ...folders[0] }, { ...folders[1], collapsed: false }])
      expect(loaded.playlist[0].folderId).toBe('a')
      await writeFile(path, JSON.stringify({ playlist: [entry('1')], keyVisualPath: null }))
      expect((await loadProjectFile(path)).playlistFolders).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
