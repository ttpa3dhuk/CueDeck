import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { sanitizeSlideFadeMs, slideNavigationPatch } from '../src/shared/slide-transition'
import { loadProjectFile, saveProjectFile } from '../src/main/project'

describe('per-presentation slide fade', () => {
  it('keeps cuts by default and bounds enabled durations', () => {
    expect([undefined, null, 0, -1, Infinity, '300'].map(sanitizeSlideFadeMs)).toEqual([0, 0, 0, 0, 0, 0])
    expect([1, 100, 299.8, 500, 2000].map(sanitizeSlideFadeMs)).toEqual([100, 100, 300, 500, 500])
  })
  it('changes slide, transition and source video policy atomically without changing speaker clocks', () => {
    const store = new StateStore()
    store.patch({ fileKind: 'pptx', totalSlides: 3, currentSlide: 1, currentPlaylistId: 'deck',
      playlist: [{ id: 'deck', kind: 'pptx', filePath: '/deck.pptx', fileName: 'deck', displayName: '', speakerName: '', durationMs: 300000, slideFadeMs: 400 }],
      slideMedia: [{ slide: 2, file: 'clip.mp4', rect: { x: 0, y: 0, w: 1, h: 1 }, autoPlay: true, loop: true }] })
    const patch = slideNavigationPatch(store.get(), 2, 'transition-1', 2000)!
    expect(patch.currentSlide).toBe(2)
    expect(patch.takeTransition).toEqual({ id: 'transition-1', durationMs: 400, scope: 'slide' })
    expect(patch.video).toMatchObject({ playing: true, anchorSec: 0, anchorAt: 2000 })
    expect(patch.videoLoop).toBe(true)
    expect(patch).not.toHaveProperty('timer')
    expect(patch).not.toHaveProperty('audienceTimer')
    expect(slideNavigationPatch(store.get(), 1, 'same')).toBeNull()
    expect(slideNavigationPatch(store.get(), 4, 'outside')).toBeNull()
    expect(slideNavigationPatch({ ...store.get(), fileKind: 'video' }, 2, 'not-slides')).toBeNull()
    const pdf = slideNavigationPatch({ ...store.get(), fileKind: 'pdf', currentPlaylistId: null }, 2, 'cut')!
    expect(pdf.takeTransition?.durationMs).toBe(0)
    expect(pdf).not.toHaveProperty('video')
  })
  it('retains the setting when a project is reopened and accepts legacy entries without it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cuedeck-slide-fade-'))
    try {
      const entry = { id: 'deck', kind: 'pdf' as const, filePath: join(root, 'deck.pdf'), fileName: 'deck.pdf', displayName: '', speakerName: '', durationMs: 0, slideFadeMs: 350 }
      const path = join(root, 'show.pdpres')
      await saveProjectFile(path, { playlist: [entry, { ...entry, id: 'legacy', slideFadeMs: undefined }], keyVisualPath: null })
      const loaded = await loadProjectFile(path)
      expect(loaded.playlist[0].slideFadeMs).toBe(350)
      expect(loaded.playlist[1].slideFadeMs).toBeUndefined()
    } finally { await rm(root, { recursive: true }) }
  })
})

import { SlidePaintTracker } from '../src/renderer/shared/slide-paint'
it('keeps an interrupted render unready until the latest draw finishes, including back to the old page', () => {
  const paint = new SlidePaintTracker()
  const first = paint.begin(); expect(paint.finish(first)).toBe(true)
  const second = paint.begin()
  expect(paint.pending).toBe(true)
  const backToFirst = paint.begin()
  expect(paint.finish(second)).toBe(false)
  expect(paint.pending).toBe(true)
  expect(paint.finish(backToFirst)).toBe(true)
  expect(paint.pending).toBe(false)
  expect(paint.finish(second)).toBe(false)
})

import { overlayFrameReady } from '../src/renderer/shared/slide-paint'
it('holds the outgoing frame until the matching video has decoded and completed its seek', () => {
  expect(overlayFrameReady('new', 'old', null, 4, false)).toBe(false)
  expect(overlayFrameReady('new', 'new', null, 1, false)).toBe(false)
  expect(overlayFrameReady('new', 'new', null, 4, true)).toBe(false)
  expect(overlayFrameReady('new', 'new', null, 2, false)).toBe(true)
  expect(overlayFrameReady('new', null, 'new', 0, false)).toBe(true)
})
