import { describe, expect, it } from 'vitest'
import { pptxFadeDuration, pptxSlideTransition, pushOffset } from '../src/shared/pptx-transition'
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

it('carries an authored Push direction and duration into navigation and honors the operator cut override', () => {
  const push = pptxSlideTransition('<p:transition p14:dur="950"><p:push dir="u"/></p:transition>')
  expect(push).toEqual({ kind: 'push', direction: 'u', durationMs: 950 })
  expect(pushOffset('u', 1600, 900)).toEqual({ x: 0, y: -900 })
  expect(pushOffset('r', 1600, 900)).toEqual({ x: 1600, y: 0 })
  const state = { fileKind: 'pptx', currentSlide: 1, totalSlides: 2, playlist: [], currentPlaylistId: null,
    slideMedia: [], slideTransitions: { 1: 0, 2: push }, video: { muted: true } } as unknown as AppState
  expect(slideNavigationPatch(state, 2, 'move')?.takeTransition).toEqual({
    id: 'move', durationMs: 950, pushDirection: 'u', scope: 'slide',
  })
  const cut = { id: 'cut', slideFadeMode: 'cut' } as PlaylistEntry
  expect(slideNavigationPatch({ ...state, currentPlaylistId: cut.id, playlist: [cut] }, 2, 'operator-cut')?.takeTransition)
    .toEqual({ id: 'operator-cut', durationMs: 0, scope: 'slide' })
})

it.each([
  ['<p:fade/>', { kind: 'fade', durationMs: 950 }],
  ['<p:fade thruBlk="1"/>', { kind: 'fade-black', durationMs: 950 }],
  ['<p:wipe dir="u"/>', { kind: 'wipe', direction: 'u', durationMs: 950 }],
  ['<p:cover dir="r"/>', { kind: 'cover', direction: 'r', durationMs: 950 }],
  ['<p:pull dir="d"/>', { kind: 'pull', direction: 'd', durationMs: 950 }],
] as const)('preserves authored transition parameters for %s', (tag, effect) => {
  const parsed = pptxSlideTransition(`<p:transition p14:dur="950">${tag}</p:transition>`)
  expect(parsed).toEqual(effect)
  const state = { fileKind: 'pptx', currentSlide: 1, totalSlides: 2, playlist: [], currentPlaylistId: null,
    slideMedia: [], slideTransitions: { 1: 0, 2: parsed }, video: { muted: true } } as unknown as AppState
  expect(slideNavigationPatch(state, 2, 'variant')?.takeTransition).toEqual({
    id: 'variant', scope: 'slide', durationMs: 950, slideEffect: effect,
  })
})
