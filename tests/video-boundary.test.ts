import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialDeckState, StateStore } from '../src/main/state'
import { VideoBoundaryScheduler } from '../src/main/video-boundary'
import type { PlaylistEntry, VideoState } from '../src/shared/types'

const T0 = 1_000_000

function entry(partial: Partial<PlaylistEntry> = {}): PlaylistEntry {
  return {
    id: 'a', kind: 'video', filePath: '/a.mp4', fileName: 'a.mp4',
    displayName: '', speakerName: '', durationMs: 0, ...partial,
  }
}

function video(partial: Partial<VideoState> = {}): VideoState {
  return { playing: false, anchorSec: 0, anchorAt: null, durationSec: 30, muted: false, range: null, seekSeq: 0, ...partial }
}

function makeStore(partial: { playlist?: PlaylistEntry[]; program?: Partial<VideoState>; preview?: Partial<VideoState>; loop?: boolean } = {}) {
  const store = new StateStore()
  store.patch({
    playlist: partial.playlist ?? [entry()],
    currentPlaylistId: 'a',
    pdfPath: '/a.mp4', pdfSha1: 'a', fileKind: 'video',
    video: video(partial.program),
    preview: { ...initialDeckState(), path: '/a.mp4', sha1: 'a', kind: 'video', playlistId: 'a', video: video(partial.preview) },
    videoLoop: Boolean(partial.loop),
  })
  return store
}

let scheduler: VideoBoundaryScheduler | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  scheduler?.stop()
  scheduler = null
  vi.useRealTimers()
})

describe('main Out deadline', () => {
  it('pauses a sub-50ms range on Out instead of waiting for a 250ms tick', () => {
    const store = makeStore({ program: { playing: true, anchorAt: T0, range: { inSec: 0, outSec: 0.01 } } })
    scheduler = new VideoBoundaryScheduler(store)
    scheduler.start()
    vi.advanceTimersByTime(5)
    expect(store.get().video.playing).toBe(true)
    vi.advanceTimersByTime(10)
    expect(store.get().video).toMatchObject({ playing: false, anchorSec: 0.01, anchorAt: null })
  })

  it('loops a short range from In and keeps the clock running', () => {
    const store = makeStore({
      playlist: [entry({ loop: true })],
      loop: true,
      program: { playing: true, anchorSec: 0, anchorAt: T0, range: { inSec: 0, outSec: 0.01 } },
    })
    scheduler = new VideoBoundaryScheduler(store)
    scheduler.start()
    vi.advanceTimersByTime(35)
    const v = store.get().video
    expect(v.playing).toBe(true)
    expect(v.anchorSec).toBe(0)
    // Fake timers ran several loop deadlines; anchor stays at In between fires.
    expect(v.range).toEqual({ inSec: 0, outSec: 0.01 })
  })

  it('cancels the deadline when the user pauses or seeks', () => {
    const store = makeStore({ program: { playing: true, anchorAt: T0, range: { inSec: 0, outSec: 0.1 } } })
    scheduler = new VideoBoundaryScheduler(store)
    scheduler.start()
    vi.advanceTimersByTime(20)
    store.patchVideo({ playing: false, anchorSec: 0.02, anchorAt: null })
    vi.advanceTimersByTime(500)
    expect(store.get().video).toMatchObject({ playing: false, anchorSec: 0.02 })
  })

  it('reschedules when In/Out changes while playing', () => {
    const store = makeStore({ program: { playing: true, anchorAt: T0, range: { inSec: 0, outSec: 1 } } })
    scheduler = new VideoBoundaryScheduler(store)
    scheduler.start()
    vi.advanceTimersByTime(10)
    store.patchVideo({ range: { inSec: 0, outSec: 0.03 } })
    vi.advanceTimersByTime(10)
    expect(store.get().video.playing).toBe(true)
    vi.advanceTimersByTime(20)
    expect(store.get().video).toMatchObject({ playing: false, anchorSec: 0.03 })
  })

  it('applies the same deadline to the preview deck', () => {
    const store = makeStore({ preview: { playing: true, anchorAt: T0, range: { inSec: 0, outSec: 0.01 } } })
    scheduler = new VideoBoundaryScheduler(store)
    scheduler.start()
    vi.advanceTimersByTime(20)
    expect(store.get().preview.video).toMatchObject({ playing: false, anchorSec: 0.01 })
  })

  it('stops clearing timers after stop()', () => {
    const store = makeStore({ program: { playing: true, anchorAt: T0, range: { inSec: 0, outSec: 0.01 } } })
    scheduler = new VideoBoundaryScheduler(store)
    scheduler.start()
    scheduler.stop()
    vi.advanceTimersByTime(100)
    expect(store.get().video.playing).toBe(true)
    scheduler = null
  })
})
