import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { VideoBoundaryScheduler } from '../src/main/video-boundary'
import { autoVideoIdentity, autoVideoTarget } from '../src/shared/video-auto-advance'

afterEach(() => vi.useRealTimers())
function setup() {
  const store = new StateStore()
  store.patch({ fileKind: 'pptx', pdfPath: '/deck.pptx', pdfSha1: 'sha', totalSlides: 3, currentSlide: 1,
    autoAdvance: true, slideMedia: [{ slide: 1, file: 'clip.mp4', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    slideTransitions: { 2: 400 }, video: { playing: true, anchorSec: 0, anchorAt: Date.now(), durationSec: 10, muted: true } })
  return store
}
describe('video automatic advance', () => {
  it('opts in through Auto advance and respects loops, lists and static slides', () => {
    const s = setup().get()
    expect(autoVideoTarget(s)).toEqual({ slide: 2, fadeMs: 400 })
    for (const patch of [{ autoAdvance: false }, { videoLoop: true }, { listIndex: 0 }, { slideMedia: [] }, { fileKind: 'live' as const }])
      expect(autoVideoTarget({ ...s, ...patch })).toBeNull()
  })
  it('starts one transition at Out without cutting off the audio tail or touching preview', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const store = setup(); const run = vi.fn(() => { store.patch({ currentSlide: 2, video: { ...store.get().video, playing: false } }); return true })
    const scheduler = new VideoBoundaryScheduler(store, { eligible: s => Boolean(autoVideoTarget(s)), run })
    scheduler.start()
    vi.advanceTimersByTime(9999); expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(run).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000); expect(run).toHaveBeenCalledOnce()
    expect(store.get().preview.video.playing).toBe(false)
    scheduler.stop()
  })
  it('reschedules a pause/seek and cancels when Auto advance is switched off', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const store = setup(); const run = vi.fn(() => true)
    const scheduler = new VideoBoundaryScheduler(store, { eligible: s => Boolean(autoVideoTarget(s)), run })
    scheduler.start(); vi.advanceTimersByTime(5000)
    store.patchVideo({ playing: false, anchorSec: 5, anchorAt: null }); vi.advanceTimersByTime(10000)
    expect(run).not.toHaveBeenCalled()
    store.patchVideo({ playing: true, anchorAt: Date.now(), range: { inSec: 0, outSec: 9 } }); store.patch({ autoAdvance: false })
    vi.advanceTimersByTime(6000)
    expect(run).not.toHaveBeenCalled(); expect(store.get().video.playing).toBe(false)
    scheduler.stop()
  })
  it('invalidates a pending target on manual navigation, pause or loop/auto changes', () => {
    const s = setup().get(); const id = autoVideoIdentity(s)
    for (const patch of [{ currentSlide: 2 }, { autoAdvance: false }, { videoLoop: true }, { video: { ...s.video, playing: false } }])
      expect(autoVideoIdentity({ ...s, ...patch })).not.toBe(id)
  })
})
