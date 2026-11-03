import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { initialState, store } from '../src/main/state'
import { sessionCheckpoint } from '../src/shared/startup-settings'
import { restoreSessionDecks } from '../src/main/session-restore'

beforeEach(() => { store.patch(initialState()) })
function playingShow() {
  store.patch({ pdfPath: '/old.mp4', fileKind: 'video', currentPlaylistId: 'old',
    video: { ...store.get().video, playing: true, anchorAt: Date.now() } })
  store.patchPreview({ path: '/old-preview.mp4', kind: 'video',
    video: { ...store.get().preview.video, playing: true, anchorAt: Date.now() } })
  store.patchTimer({ running: true, startedAt: Date.now() })
}
it('restoring empty decks stops and removes both previous playing videos', async () => {
  const saved = sessionCheckpoint(initialState())
  saved.timer.elapsedMs = 1234
  playingShow()
  const loaders = { program: vi.fn(), preview: vi.fn() }
  expect(await restoreSessionDecks(saved, loaders)).toEqual({ ok: true })
  expect(loaders.program).not.toHaveBeenCalled()
  expect(loaders.preview).not.toHaveBeenCalled()
  expect(store.get()).toMatchObject({ pdfPath: null, fileKind: null, currentPlaylistId: null,
    video: { playing: false }, preview: { path: null, video: { playing: false } },
    timer: { running: false, startedAt: null, elapsedMs: 1234 } })
})
it('missing program still restores valid preview and paused timers without retaining old media', async () => {
  const saved = sessionCheckpoint(initialState())
  saved.program.path = '/missing.pdf'
  saved.preview.path = '/valid.pdf'; saved.preview.slide = 3
  saved.timer.elapsedMs = 1234; saved.audienceTimer.elapsedMs = 5678
  playingShow()
  const result = await restoreSessionDecks(saved, {
    program: async () => ({ ok: false, error: 'missing program' }),
    preview: async path => { store.patchPreview({ path, totalSlides: 4 }); return { ok: true } },
  })
  expect(result).toMatchObject({ ok: false, error: 'missing program' })
  expect(store.get()).toMatchObject({ pdfPath: null, video: { playing: false },
    preview: { path: '/valid.pdf', currentSlide: 3, video: { playing: false } },
    timer: { running: false, elapsedMs: 1234 }, audienceTimer: { running: false, elapsedMs: 5678 } })
})
it('missing preview does not leave old preview or discard recovered program/timer state', async () => {
  const saved = sessionCheckpoint(initialState())
  saved.program.path = '/valid.pdf'; saved.program.slide = 4
  saved.preview.path = '/missing.pdf'; saved.timer.elapsedMs = 999
  playingShow()
  const result = await restoreSessionDecks(saved, {
    program: async path => { store.patch({ pdfPath: path, totalSlides: 5 }); return { ok: true } },
    preview: async () => ({ ok: false, error: 'missing preview' }),
  })
  expect(result.ok).toBe(false)
  expect(store.get()).toMatchObject({ pdfPath: '/valid.pdf', currentSlide: 4,
    preview: { path: null, video: { playing: false } }, timer: { elapsedMs: 999, running: false } })
})
