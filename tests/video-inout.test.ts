import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { initialDeckState, StateStore } from '../src/main/state'
import { VideoInOutController, rangeApplicationPatch } from '../src/main/video-inout'
import { registerVideoInOutIpc } from '../src/main/video-inout-ipc'
import type { PlaylistEntry, VideoState } from '../src/shared/types'
import type { FrameTimelineProbeResult } from '../src/shared/frame-timeline'

const T0 = 1_000_000

function entry(partial: Partial<PlaylistEntry> = {}): PlaylistEntry {
  return {
    id: 'a', kind: 'video', filePath: '/same.mp4', fileName: 'same.mp4',
    displayName: '', speakerName: '', durationMs: 0, ...partial,
  }
}

function video(partial: Partial<VideoState> = {}): VideoState {
  return { playing: false, anchorSec: 0, anchorAt: null, durationSec: 30, muted: true, range: null, seekSeq: 0, ...partial }
}

function makeStore(opts: {
  playlist?: PlaylistEntry[]
  program?: Partial<VideoState>
  preview?: Partial<VideoState>
  previewEntry?: string | null
  loop?: boolean
} = {}) {
  const store = new StateStore()
  store.patch({
    playlist: opts.playlist ?? [entry()],
    currentPlaylistId: 'a',
    pdfPath: '/program.mp4',
    pdfSha1: 'program',
    fileKind: 'video',
    video: video(opts.program),
    preview: {
      ...initialDeckState(),
      path: '/preview.mp4',
      sha1: 'preview',
      kind: 'video',
      playlistId: opts.previewEntry === undefined ? 'a' : opts.previewEntry,
      video: video(opts.preview),
    },
    videoLoop: Boolean(opts.loop),
  })
  return store
}

function okFrames(timestamps: number[]) {
  return vi.fn(async (_path: string): Promise<FrameTimelineProbeResult> => ({ ok: true, timeline: { timestamps } }))
}

describe('VideoInOutController step wiring', () => {
  it('uses fileKind/pdfPath for program and preview.kind/path for preview', async () => {
    const store = makeStore()
    const frames = okFrames([0, 0.04, 0.08])
    const controller = new VideoInOutController(store, { get: frames }, () => undefined)

    await expect(controller.stepFrame('program', 1)).resolves.toEqual({ ok: true, position: 0.04 })
    expect(frames).toHaveBeenLastCalledWith('/program.mp4', 0, 30)
    await expect(controller.stepFrame('preview', 1)).resolves.toEqual({ ok: true, position: 0.04 })
    expect(frames).toHaveBeenLastCalledWith('/preview.mp4', 0, 30)
  })

  it('serialises rapid arrows so each one steps from the previous result', async () => {
    const store = makeStore()
    const frames = okFrames([0, 0.04, 0.08, 0.12])
    const controller = new VideoInOutController(store, { get: frames }, () => undefined)

    const first = controller.stepFrame('program', 1)
    const second = controller.stepFrame('program', 1)
    await expect(first).resolves.toEqual({ ok: true, position: 0.04 })
    await expect(second).resolves.toEqual({ ok: true, position: 0.08 })
    expect(frames).toHaveBeenCalledTimes(2)
  })

  it('drops a late ffprobe result when the deck switched files', async () => {
    const store = makeStore({ program: { anchorSec: 5, playing: false } })
    let resolveProbe!: (value: FrameTimelineProbeResult) => void
    const frames = { get: vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { resolveProbe = resolve })) }
    const controller = new VideoInOutController(store, frames, () => undefined)

    const pending = controller.stepFrame('program', 1)
    await vi.waitFor(() => expect(frames.get).toHaveBeenCalledOnce())
    store.patch({ pdfPath: '/other.mp4', pdfSha1: 'other' })
    resolveProbe({ ok: true, timeline: { timestamps: [0, 0.04, 0.08] } })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(store.get().video.anchorSec).toBe(5)
  })

  it('discards a step when the same file switched to another entry id', async () => {
    const store = makeStore({
      playlist: [entry({ id: 'a' }), entry({ id: 'b' })],
      program: { anchorSec: 0, playing: false },
    })
    let resolveProbe!: (value: FrameTimelineProbeResult) => void
    const frames = { get: vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { resolveProbe = resolve })) }
    const controller = new VideoInOutController(store, frames, () => undefined)
    const pending = controller.stepFrame('program', 1, { entryId: 'a', path: '/program.mp4', sha1: 'program' })
    await vi.waitFor(() => expect(frames.get).toHaveBeenCalledOnce())
    store.patch({ currentPlaylistId: 'b' }) // same file, different card
    resolveProbe({ ok: true, timeline: { timestamps: [0, 0.04] } })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(store.get().video.anchorSec).toBe(0)
  })

  it('does not re-pause a video the user resumed during a slow probe', async () => {
    const store = makeStore({ program: { anchorSec: 0, playing: false } })
    let resolveProbe!: (value: FrameTimelineProbeResult) => void
    const frames = { get: vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { resolveProbe = resolve })) }
    const controller = new VideoInOutController(store, frames, () => undefined)
    const pending = controller.stepFrame('program', 1, { entryId: 'a', path: '/program.mp4', sha1: 'program' })
    await vi.waitFor(() => expect(frames.get).toHaveBeenCalledOnce())
    store.patch({ video: { ...store.get().video, playing: true, anchorSec: 7, anchorAt: T0 } })
    resolveProbe({ ok: true, timeline: { timestamps: [0, 0.04, 0.08] } })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(store.get().video).toMatchObject({ playing: true, anchorSec: 7 })
  })

  it('returns MM:SS:FF labels from the same decoded-frame windows', async () => {
    const frames = [0, 0.04, 0.08, 1.5]
    const store = makeStore({
      playlist: [entry({ inSec: 0.04, outSec: 1.5 })],
      program: { anchorSec: 0.08, playing: false, durationSec: 1.625, range: { inSec: 0.04, outSec: 1.5 } },
    })
    const provider = { get: vi.fn(async () => ({ ok: true as const, timeline: { timestamps: frames } })) }
    const controller = new VideoInOutController(store, provider, () => undefined)
    await expect(controller.timecode('program')).resolves.toEqual({
      current: '00:00:02',
      total: '00:01:01',
      in: '00:00:01',
      out: '00:01:00',
      identity: { entryId: 'a', path: '/program.mp4', sha1: 'program' },
    })
  })

  it('returns null from timecode if the deck changed while windows loaded', async () => {
    const store = makeStore({ program: { anchorSec: 0.08, durationSec: 1.625 } })
    let release!: (value: { ok: true; timeline: { timestamps: number[] } }) => void
    const shared = new Promise<{ ok: true; timeline: { timestamps: number[] } }>((resolve) => { release = resolve })
    const provider = { get: vi.fn(() => shared) }
    const controller = new VideoInOutController(store, provider, () => undefined)
    const pending = controller.timecode('program')
    await vi.waitFor(() => expect(provider.get).toHaveBeenCalledTimes(2))
    store.patch({ pdfPath: '/other.mp4', pdfSha1: 'other' })
    release({ ok: true, timeline: { timestamps: [0, 0.04] } })
    await expect(pending).resolves.toBeNull()
  })

  it('discards a step when the user seeks during the probe', async () => {
    const store = makeStore({ program: { anchorSec: 0, playing: false } })
    let resolveProbe!: (value: FrameTimelineProbeResult) => void
    const frames = { get: vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { resolveProbe = resolve })) }
    const controller = new VideoInOutController(store, frames, () => undefined)
    const pending = controller.stepFrame('program', 1)
    await vi.waitFor(() => expect(frames.get).toHaveBeenCalledOnce())
    store.patchVideo({ anchorSec: 7, anchorAt: null, playing: false })
    resolveProbe({ ok: true, timeline: { timestamps: [0, 0.04, 0.08] } })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(store.get().video.anchorSec).toBe(7)
  })

  it('discards a step when In/Out changes during the probe', async () => {
    const store = makeStore({ program: { anchorSec: 0, playing: false } })
    let resolveProbe!: (value: FrameTimelineProbeResult) => void
    const frames = { get: vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { resolveProbe = resolve })) }
    const controller = new VideoInOutController(store, frames, () => undefined)
    const pending = controller.stepFrame('program', 1)
    await vi.waitFor(() => expect(frames.get).toHaveBeenCalledOnce())
    store.patchVideo({ range: { inSec: 1, outSec: 9 } })
    resolveProbe({ ok: true, timeline: { timestamps: [0, 0.04, 0.08] } })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(store.get().video.anchorSec).toBe(0)
    expect(store.get().video.range).toEqual({ inSec: 1, outSec: 9 })
  })

  it('invalidates queued arrows when a user seek wins the race', async () => {
    const store = makeStore({ program: { anchorSec: 0, playing: false } })
    let resolveProbe!: (value: FrameTimelineProbeResult) => void
    const frames = { get: vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { resolveProbe = resolve })) }
    const controller = new VideoInOutController(store, frames, () => undefined)
    const identity = { entryId: 'a', path: '/program.mp4', sha1: 'program' }
    const first = controller.stepFrame('program', 1, identity)
    const second = controller.stepFrame('program', 1, identity)
    await vi.waitFor(() => expect(frames.get).toHaveBeenCalledOnce())
    store.patchVideo({ anchorSec: 7, anchorAt: null, playing: false })
    resolveProbe({ ok: true, timeline: { timestamps: [0, 0.04, 0.08] } })
    await expect(first).resolves.toEqual({ ok: false, reason: 'stale' })
    await expect(second).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(store.get().video.anchorSec).toBe(7)
  })

  it('discards a queued arrow after a card switch instead of stepping the new file', async () => {
    const store = makeStore({ program: { anchorSec: 0, playing: false } })
    let releases: Array<(value: FrameTimelineProbeResult) => void> = []
    const frames = { get: vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { releases.push(resolve) })) }
    const controller = new VideoInOutController(store, frames, () => undefined)
    const identity = { entryId: 'a', path: '/program.mp4', sha1: 'program' }
    const first = controller.stepFrame('program', 1, identity)
    const second = controller.stepFrame('program', 1, identity)
    await vi.waitFor(() => expect(frames.get).toHaveBeenCalledOnce())
    store.patch({ pdfPath: '/new.mp4', pdfSha1: 'new' })
    releases[0]({ ok: true, timeline: { timestamps: [0, 0.04, 0.08] } })
    await expect(first).resolves.toEqual({ ok: false, reason: 'stale' })
    await expect(second).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(store.get().video.anchorSec).toBe(0)
  })

  it('fetches the neighbouring window when the scanned chunk ends at the target', async () => {
    const store = makeStore({
      program: { anchorSec: 0.04, playing: false, durationSec: 30 },
    })
    const get = vi.fn(async (_path: string, position?: number) => position === undefined
      ? { ok: true as const, timeline: { timestamps: [0, 0.04] } }
      : { ok: true as const, timeline: { timestamps: [0, 0.04] } })
    const getWindow = vi.fn(async () => ({ ok: true as const, timeline: { timestamps: [0.04, 0.08] } }))
    const controller = new VideoInOutController(store, { get, getWindow }, () => undefined)
    await expect(controller.stepFrame('program', 1)).resolves.toEqual({ ok: true, position: 0.08 })
    expect(getWindow).toHaveBeenCalledOnce()
  })

  it('fetches the previous window for a backward step instead of reporting edge', async () => {
    const store = makeStore({
      program: { anchorSec: 0.04, playing: false, durationSec: 30 },
    })
    const get = vi.fn(async () => ({ ok: true as const, timeline: { timestamps: [0.04, 0.08] } }))
    const getWindow = vi.fn(async () => ({ ok: true as const, timeline: { timestamps: [0, 0.04] } }))
    const controller = new VideoInOutController(store, { get, getWindow }, () => undefined)
    await expect(controller.stepFrame('program', -1)).resolves.toEqual({ ok: true, position: 0 })
    expect(getWindow).toHaveBeenCalledOnce()
  })

  it('rejects decoded PTS beyond Chromium media duration, including window fallback', async () => {
    const store = makeStore({
      program: { anchorSec: 1.5, playing: false, durationSec: 1.625 },
    })
    const get = vi.fn(async (_path: string, position?: number) => ({
      ok: true as const,
      timeline: { timestamps: (position ?? 0) < 1.5 ? [1.0, 1.5] : [1.5, 1.75] },
    }))
    const controller = new VideoInOutController(store, { get }, () => undefined)
    await expect(controller.stepFrame('program', 1)).resolves.toEqual({ ok: false, reason: 'edge' })
    expect(store.get().video.anchorSec).toBe(1.5)
    await expect(controller.stepFrame('program', -1)).resolves.toEqual({ ok: true, position: 1.0 })

    const fallbackStore = makeStore({
      program: { anchorSec: 1.5, playing: false, durationSec: 1.625 },
    })
    const fallbackGet = vi.fn(async () => ({ ok: true as const, timeline: { timestamps: [1.5] } }))
    const getWindow = vi.fn(async () => ({ ok: true as const, timeline: { timestamps: [1.75] } }))
    const fallback = new VideoInOutController(fallbackStore, { get: fallbackGet, getWindow }, () => undefined)
    await expect(fallback.stepFrame('program', 1)).resolves.toEqual({ ok: false, reason: 'edge' })
    expect(fallbackStore.get().video.anchorSec).toBe(1.5)
  })

  it('bounds a frame step to the applied range', async () => {
    const store = makeStore({ program: { anchorSec: 19.99, range: { inSec: 10, outSec: 20 } } })
    const controller = new VideoInOutController(store, { get: okFrames([10, 15, 19.99, 20.01]) }, () => undefined)
    await expect(controller.stepFrame('program', 1)).resolves.toEqual({ ok: false, reason: 'edge' })
    expect(store.get().video.anchorSec).toBe(19.99)
  })
})

describe('VideoInOutController immediate In/Out policy', () => {
  it('updates both decks when they show the same entry id', () => {
    const store = makeStore({
      program: { anchorSec: 5, playing: true, anchorAt: T0, muted: true },
      preview: { anchorSec: 20, playing: false },
    })
    const persist = vi.fn()
    const controller = new VideoInOutController(store, { get: okFrames([]) }, persist)

    expect(controller.setRange('preview', 'in', T0)).toMatchObject({ ok: true, applied: 'immediate' })
    const s = store.get()
    expect(s.video.range).toEqual({ inSec: 20, outSec: 30 })
    expect(s.video.anchorSec).toBe(20)
    expect(s.video.playing).toBe(true)
    expect(s.video.muted).toBe(true)
    expect(s.preview.video.range).toEqual({ inSec: 20, outSec: 30 })
    expect(s.playlist[0]).toMatchObject({ inSec: 20, outSec: 30 })
    expect(persist).toHaveBeenCalledOnce()
  })

  it('program edit updates the preview deck on the same entry too', () => {
    const store = makeStore({
      program: { anchorSec: 12, playing: false },
      preview: { anchorSec: 8, playing: false },
    })
    const controller = new VideoInOutController(store, { get: okFrames([]) }, () => undefined)
    controller.setRange('program', 'out', T0)
    const s = store.get()
    expect(s.video.range).toEqual({ inSec: 0, outSec: 12 })
    expect(s.preview.video.range).toEqual({ inSec: 0, outSec: 12 })
    expect(s.preview.video.anchorSec).toBe(8)
  })

  it('pauses at Out for a non-loop clip and preserves muted', () => {
    const store = makeStore({
      program: { anchorSec: 25, playing: true, anchorAt: T0, muted: true },
      preview: { anchorSec: 15, playing: false },
    })
    const controller = new VideoInOutController(store, { get: okFrames([]) }, () => undefined)
    controller.setRange('preview', 'out', T0)
    const s = store.get()
    expect(s.video.range).toEqual({ inSec: 0, outSec: 15 })
    expect(s.video).toMatchObject({ playing: false, anchorSec: 15, anchorAt: null, muted: true })
    expect(s.preview.video).toMatchObject({ range: { inSec: 0, outSec: 15 }, anchorSec: 15 })
  })

  it('wraps to In for a looping clip', () => {
    const store = makeStore({
      playlist: [entry({ loop: true })],
      loop: true,
      program: { anchorSec: 25, playing: true, anchorAt: T0 },
      preview: { anchorSec: 15, playing: false },
    })
    const controller = new VideoInOutController(store, { get: okFrames([]) }, () => undefined)
    controller.setRange('preview', 'out', T0)
    expect(store.get().video).toMatchObject({
      range: { inSec: 0, outSec: 15 }, anchorSec: 0, playing: true,
    })
  })

  it('keeps duplicate same-file entries independent by id', () => {
    const store = makeStore({
      playlist: [entry({ id: 'a' }), entry({ id: 'b' })],
      previewEntry: 'b',
      program: { anchorSec: 12, playing: false },
      preview: { anchorSec: 12, playing: false },
    })
    const controller = new VideoInOutController(store, { get: okFrames([]) }, () => undefined)
    controller.setRange('program', 'in', T0)
    let s = store.get()
    expect(s.video.range).toEqual({ inSec: 12, outSec: 30 })
    expect(s.preview.video.range).toBeNull()
    expect(s.playlist.find((e) => e.id === 'a')).toMatchObject({ inSec: 12 })
    expect(s.playlist.find((e) => e.id === 'b')?.inSec).toBeUndefined()

    controller.setRange('preview', 'out', T0)
    s = store.get()
    expect(s.preview.video.range).toEqual({ inSec: 0, outSec: 12 })
    expect(s.video.range).toEqual({ inSec: 12, outSec: 30 })
  })

  it('reset clears bounds without jumping or restarting', () => {
    const store = makeStore({
      program: { anchorSec: 20, playing: false, range: { inSec: 10, outSec: 20 } },
      preview: { anchorSec: 20, playing: false, range: { inSec: 10, outSec: 20 } },
    })
    store.patch({ playlist: [entry({ inSec: 10, outSec: 20 })] })
    const controller = new VideoInOutController(store, { get: okFrames([]) }, () => undefined)
    controller.setRange('program', 'reset', T0)
    const s = store.get()
    expect(s.video.range).toBeNull()
    expect(s.video).toMatchObject({ anchorSec: 20, playing: false })
    expect(s.preview.video.range).toBeNull()
    expect(s.preview.video.anchorSec).toBe(20)
    expect(s.playlist[0].inSec).toBeUndefined()
  })

  it('reports list entries as unsupported instead of editing the wrong thing', () => {
    const store = makeStore()
    store.patch({
      playlist: [entry({ id: 'list', kind: 'list', filePath: '', items: [{ path: '/v.mp4', fileName: 'v.mp4', kind: 'video' }] })],
      currentPlaylistId: 'list',
    })
    const controller = new VideoInOutController(store, { get: okFrames([]) }, () => undefined)
    expect(controller.setRange('program', 'in', T0)).toEqual({ ok: false, code: 'list-unsupported' })
  })

  it('applies ranges without touching ffprobe (frame stepping is optional)', () => {
    const store = makeStore({
      program: { anchorSec: 5, playing: true, anchorAt: T0 },
      preview: { anchorSec: 5, playing: true, anchorAt: T0 },
    })
    const frames = { get: vi.fn() }
    const controller = new VideoInOutController(store, frames, () => undefined)
    expect(controller.setRange('program', 'in', T0)).toMatchObject({ ok: true })
    expect(frames.get).not.toHaveBeenCalled()
  })

  it('rejects In >= Out and keeps the previous values', () => {
    const store = makeStore({
      playlist: [entry({ inSec: 10, outSec: 20 })],
      program: { anchorSec: 10, range: { inSec: 10, outSec: 20 } },
    })
    const controller = new VideoInOutController(store, { get: okFrames([]) }, () => undefined)
    expect(controller.setRange('program', 'out', T0)).toEqual({ ok: false, code: 'invalid-range' })
    expect(store.get().video.range).toEqual({ inSec: 10, outSec: 20 })
  })
})

describe('rangeApplicationPatch', () => {
  it('inside keeps the raw clock untouched', () => {
    expect(rangeApplicationPatch(video({ anchorSec: 15, playing: true, anchorAt: T0 }), { inSec: 10, outSec: 20 }, false, T0))
      .toEqual({ range: { inSec: 10, outSec: 20 } })
  })
  it('reset never seeks', () => {
    expect(rangeApplicationPatch(video({ anchorSec: 20 }), null, true, T0)).toEqual({ range: null })
  })
})

describe('video IPC registration', () => {
  it('main ipc wires the tested registrar and keeps no duplicate handlers', () => {
    const source = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')
    expect(source).toContain('registerVideoInOutIpc(ipcMain, videoInOut)')
    expect(source).not.toContain("ipcMain.handle('video:step-frame'")
    expect(source).not.toContain("ipcMain.handle('video:set-range'")
  })

  it('routes deck/direction/edge and rejects unknown edges', async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    const controller = {
      stepFrame: vi.fn(async () => ({ ok: true, position: 1 })),
      setRange: vi.fn(() => ({ ok: true, applied: 'immediate' as const })),
      timecode: vi.fn(async () => null),
    }
    registerVideoInOutIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, controller)

    const identity = { entryId: 'a', path: '/a.mp4', sha1: 'a' }
    await handlers.get('video:step-frame')!(null, { deck: 'preview', direction: -1, identity })
    expect(controller.stepFrame).toHaveBeenCalledWith('preview', -1, identity)
    await handlers.get('video:step-frame')!(null, { direction: 1 })
    expect(controller.stepFrame).toHaveBeenLastCalledWith('program', 1, undefined)
    handlers.get('video:set-range')!(null, { deck: 'program', edge: 'in' })
    expect(controller.setRange).toHaveBeenCalledWith('program', 'in')
    await handlers.get('video:timecode')!(null, 'preview')
    expect(controller.timecode).toHaveBeenCalledWith('preview')
    expect(handlers.get('video:set-range')!(null, { edge: 'bogus' })).toEqual({ ok: false, code: 'invalid-range' })
  })
})
