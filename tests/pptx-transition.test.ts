import { describe, expect, it } from 'vitest'
import { pptxFadeDuration } from '../src/shared/pptx-transition'
import { slideNavigationPatch } from '../src/shared/slide-transition'
import { initialSlideVideo } from '../src/shared/slide-video'
import { programVideoSource } from '../src/shared/program-source'
import type { AppState, PlaylistEntry } from '../src/shared/types'

describe('PowerPoint Fade import', () => {
  it('reads exact Office duration and refuses unrelated/through-black effects', () => {
    expect(pptxFadeDuration('<p:transition p14:dur="350"><p:fade/></p:transition>')).toBe(350)
    expect(pptxFadeDuration('<p:transition p14:dur="900"><p:wipe/></p:transition>')).toBe(0)
    expect(pptxFadeDuration('<p:transition><p:fade thruBlk="true"/></p:transition>')).toBe(0)
    expect(pptxFadeDuration('<p:transition spd="med"><p:fade/></p:transition>')).toBe(400)
    expect(pptxFadeDuration('')).toBe(0)
  })
  const entry: PlaylistEntry = { id: 'deck', kind: 'pptx', filePath: '/deck.pptx', fileName: 'deck', displayName: '', speakerName: '', durationMs: 0 }
  const state = { fileKind: 'pptx', currentSlide: 1, totalSlides: 4, playlist: [entry], currentPlaylistId: entry.id,
    slideMedia: [], slideTransitions: { 2: 350, 4: 900 }, video: { muted: true } } as unknown as AppState
  it('uses destination Fade only, keeps click steps as cuts and applies the accepted 400 ms cap', () => {
    expect(slideNavigationPatch(state, 2, 'a')?.takeTransition?.durationMs).toBe(350)
    expect(slideNavigationPatch(state, 3, 'b')?.takeTransition?.durationMs).toBe(0)
    expect(slideNavigationPatch(state, 4, 'c')?.takeTransition?.durationMs).toBe(400)
  })
  it('preserves legacy manual settings and lets a material override the file explicitly', () => {
    const duration = (change: Partial<PlaylistEntry>) => slideNavigationPatch({ ...state, playlist: [{ ...entry, ...change }] }, 2, 'a')?.takeTransition?.durationMs
    expect(duration({ slideFadeMs: 0 })).toBe(0)
    expect(duration({ slideFadeMs: 250 })).toBe(250)
    expect(duration({ slideFadeMode: 'file', slideFadeMs: 250 })).toBe(350)
    expect(duration({ slideFadeMode: 'cut' })).toBe(0)
    expect(duration({ slideFadeMode: 'custom', slideFadeMs: 200 })).toBe(200)
  })
  it('does not repeat the source Fade while going back through click steps', () => {
    expect(slideNavigationPatch({ ...state, currentSlide: 3, slideTransitions: { 1: 0, 2: 350, 4: 0 } }, 2, 'back')?.takeTransition?.durationMs).toBe(0)
  })
  it('does not expose a GIF as a program video or apply its autoplay to the transport', () => {
    const media = [{ kind: 'gif' as const, slide: 1, file: 'image.gif', autoPlay: true, loop: true, rect: { x: 0, y: 0, w: 1, h: 1 } }]
    expect(initialSlideVideo('pptx', media, 1, true)).toMatchObject({ video: { playing: false }, videoLoop: false })
    expect(programVideoSource({ pdfSha1: 'sha', fileKind: 'pptx', slideMedia: media, currentSlide: 1 })).toBeNull()
  })
})
