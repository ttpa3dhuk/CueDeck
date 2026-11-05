import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { initialDeckState, StateStore } from '../src/main/state'
import { togglePreviewSourceMute } from '../src/shared/source-audio'
import { duplicatePlaylistEntry } from '../src/shared/playlist-folders'
import { shouldMute, shouldMuteMix } from '../src/renderer/shared/video'
import { initialSlideVideo } from '../src/shared/slide-video'
import { entryVideoRange, planVideoTake, reusedVideoDuration } from '../src/shared/video-range'
import { recoveryTakeFrame } from '../src/shared/recovery-take'
import type { AppState, FileKind, FrameStepIdentity, PlaylistEntry } from '../src/shared/types'

const entry = (id: string, sourceMuted = false): PlaylistEntry => ({
  id, sourceMuted, kind: 'video', filePath: '/same.mp4', fileName: 'same.mp4',
  displayName: '', speakerName: '', durationMs: 0,
})
const identity = (state: AppState): FrameStepIdentity => ({
  entryId: state.preview.playlistId, path: state.preview.path, sha1: state.preview.sha1,
})
function show(kind: FileKind = 'video') {
  const store = new StateStore()
  store.patch({ playlist: [entry('a'), entry('b')], currentPlaylistId: 'a',
    pdfPath: '/same.mp4', pdfSha1: 'sha', fileKind: kind,
    preview: { ...initialDeckState(), path: '/same.mp4', sha1: 'sha', kind, playlistId: 'b' },
  })
  return store
}

describe('input mute', () => {
  it.each(['video', 'pdf', 'pptx', 'image', 'live', 'list'] as const)('stores mute for a %s input without touching the mix or playback', kind => {
    const store = show(kind)
    const before = store.get()
    const patch = togglePreviewSourceMute(before, identity(before))!
    store.patch(patch)
    expect(store.get().playlist.map(e => e.sourceMuted)).toEqual([false, true])
    expect(store.get().preview.sourceMuted).toBe(true)
    expect(store.get().sourceMuted).toBe(false) // same file, different card
    expect(store.get().video).toBe(before.video)
    expect(store.get().preview.video).toBe(before.preview.video)
    expect(store.get().timer).toBe(before.timer)
    store.patch(togglePreviewSourceMute(store.get(), identity(store.get()))!)
    expect(store.get().playlist[1].sourceMuted).toBe(false)
  })

  it('updates the program immediately only for the same input id', () => {
    const store = show()
    store.patch({ currentPlaylistId: 'b' })
    store.patch(togglePreviewSourceMute(store.get(), identity(store.get()))!)
    expect(shouldMute(store.get(), 'operator')).toBe(true)
    expect(shouldMuteMix(store.get(), 'operator')).toBe(false) // timer cues still audible
    expect(store.get().video.muted).toBe(false)
    store.patchVideo({ muted: true })
    store.patch(togglePreviewSourceMute(store.get(), identity(store.get()))!)
    expect(store.get().sourceMuted).toBe(false)
    expect(shouldMute(store.get(), 'operator')).toBe(true) // mix remains muted
  })

  it('supports loose files and rejects late clicks for a replaced preview', () => {
    const store = show()
    const old = identity(store.get())
    store.patchPreview({ playlistId: null, path: '/other.pdf', sha1: 'other', kind: 'pdf' })
    expect(togglePreviewSourceMute(store.get(), old)).toBeNull()
    const patch = togglePreviewSourceMute(store.get(), identity(store.get()))!
    expect(patch.playlist).toBeUndefined()
    store.patch(patch)
    expect(store.get().preview.sourceMuted).toBe(true)
    expect(store.get().sourceMuted).toBe(false)
    store.patchPreview(initialDeckState())
    expect(togglePreviewSourceMute(store.get(), identity(store.get()))).toBeNull()
  })

  it('duplicates the preference independently and retains program mute after deleting a card', () => {
    const store = show()
    store.patch({ currentPlaylistId: 'b' })
    store.patch(togglePreviewSourceMute(store.get(), identity(store.get()))!)
    const playlist = duplicatePlaylistEntry(store.get().playlist, 'b', 'c')
    expect(playlist.find(e => e.id === 'c')?.sourceMuted).toBe(true)
    store.patch({ playlist: playlist.filter(e => e.id !== 'b'), currentPlaylistId: null })
    expect(shouldMute(store.get(), 'operator')).toBe(true)
  })

  it('combines source and mix switches for every audio role and captured solo', () => {
    const store = show()
    for (const layout of ['solo', 'presenter-audience', 'operator-speaker-audience'] as const) {
      for (const muted of [false, true]) {
        store.patch({ layout, sourceMuted: true, video: { ...store.get().video, muted } })
        for (const role of ['operator', 'audience', 'speaker'] as const) expect(shouldMute(store.get(), role)).toBe(true)
      }
    }
    store.patch({ layout: 'solo', sourceMuted: false, video: { ...store.get().video, muted: false },
      stream: { ...store.get().stream, running: true } })
    expect(shouldMute(store.get(), 'audience')).toBe(false)
    expect(shouldMute(store.get(), 'operator')).toBe(true)
    store.patch({ sourceMuted: true })
    expect(shouldMute(store.get(), 'audience')).toBe(true)
  })
})

describe('actual TAKE input mute transfer', () => {
  const source = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')
  const take = source.slice(source.indexOf("  ipcMain.handle('preview:take',"), source.indexOf("  ipcMain.handle('preview:set-fade-ms',"))

  it.each(['video', 'pdf', 'pptx', 'image', 'live'] as const)('takes %s input mute and preserves it on the swapped preview', kind => {
    const store = show(kind)
    store.patch({ sourceMuted: true })
    store.patchPreview({ sourceMuted: false })
    let handler!: (event: unknown) => void
    runInNewContext(ts.transpile(take), {
      ipcMain: { handle: (_: string, fn: typeof handler) => { handler = fn } }, store,
      programOpenGeneration: 0, previewOpenGeneration: 0, pendingDeckLoads: 0,
      randomUUID: () => 'take', sanitizeTakeFadeMs: () => 0, recoveryTakeFrame,
      initialSlideVideo, planVideoTake, entryVideoRange, reusedVideoDuration,
      stopListPlayback: vi.fn(), setLastPdfPath: vi.fn(), setCurrentPlaylistId: vi.fn(),
      materialTakeTimer: () => ({}), setLastDurationMs: vi.fn(),
    })
    handler({})
    expect(store.get().sourceMuted).toBe(false)
    expect(store.get().preview.sourceMuted).toBe(true)
    handler({})
    expect(store.get().sourceMuted).toBe(true)
    expect(store.get().preview.sourceMuted).toBe(false)
    expect(store.get().video.muted).toBe(false)
  })
})

describe('actual source load and IPC wiring', () => {
  const source = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')

  it.each(['video', 'pdf', 'pptx', 'image', 'live', 'list'] as const)('loads %s mute on both decks and resets it for a loose file', async kind => {
    for (const deck of ['program', 'preview']) {
      const store = show()
      store.patch({ playlist: [{ ...entry('b', true), kind }] })
      store.patchVideo({ muted: true })
      const start = source.indexOf(deck === 'program' ? 'async function openFile(' : 'async function loadPreview(')
      const end = source.indexOf(deck === 'program' ? '/** Load a file into' : '/** Entering a PPTX slide', start)
      const functionName = deck === 'program' ? 'openFile' : 'loadPreview'
      const load = runInNewContext(ts.transpile(source.slice(start, end)) + `\n${functionName}`, {
        store, inspectFile: async () => ({ kind: kind === 'list' ? 'video' : kind, sha1: 'sha', totalSlides: 1, notes: {}, slideMedia: [] }),
        programOpenGeneration: 0, previewOpenGeneration: 0, pendingDeckLoads: 0,
        stopListPlayback: vi.fn(), entryVideoRange, reusedVideoDuration, initialSlideVideo,
        setLastPdfPath: vi.fn(), setCurrentPlaylistId: vi.fn(), setLastDurationMs: vi.fn(),
        cancelFrameProbeIfUnused: vi.fn(), materialTakeTimer: () => ({}),
      })
      expect(await load('/same.mp4', { playlistId: 'b', fromList: kind === 'list' })).toMatchObject({ ok: true })
      expect(deck === 'program' ? store.get().sourceMuted : store.get().preview.sourceMuted).toBe(true)
      expect(await load('/loose.mp4')).toMatchObject({ ok: true })
      expect(deck === 'program' ? store.get().sourceMuted : store.get().preview.sourceMuted).toBe(false)
      expect(store.get().video.muted).toBe(true)
    }
  })

  it('allows only the operator main frame and persists only valid card edits', () => {
    const store = show()
    const wc = { mainFrame: {} }
    const persistPlaylist = vi.fn()
    let handler!: (event: unknown, identity: FrameStepIdentity) => void
    const start = source.indexOf("  ipcMain.handle('preview:toggle-source-muted',")
    const end = source.indexOf('  // Preview monitoring', start)
    runInNewContext(ts.transpile(source.slice(start, end)), {
      ipcMain: { handle: (_: string, fn: typeof handler) => { handler = fn } }, store,
      getOperatorWindow: () => ({ isDestroyed: () => false, webContents: wc }),
      togglePreviewSourceMute, persistPlaylist,
    })
    const id = identity(store.get())
    expect(() => handler({ sender: {} }, id)).toThrow('Operator')
    expect(() => handler({ sender: wc, senderFrame: {} }, id)).toThrow('Operator')
    expect(store.get().preview.sourceMuted).toBe(false)
    const operator = { sender: wc, senderFrame: wc.mainFrame }
    handler(operator, { ...id, sha1: 'old' })
    expect(persistPlaylist).not.toHaveBeenCalled()
    handler(operator, id)
    expect(persistPlaylist).toHaveBeenCalledOnce()
    expect(store.get().preview.sourceMuted).toBe(true)
  })
})
