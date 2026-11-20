import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { isVisitedLink, recordLinkedVisit } from '../src/shared/slide-visited-links'
import { visitedLinkCrops } from '../src/renderer/shared/slide-visited-links'

const rect = { x: .2, y: .3, w: .1, h: .1 }
const played = { slide: 4, rect, hideAfterVisit: { shape: '15', page: 2 } }
const ordinary = { slide: 5, rect }

describe('linked PPTX cells', () => {
  it('records only authored self-hide links and rejects a repeated visit', () => {
    const empty = { slideVisitedLinks: undefined }
    expect(recordLinkedVisit(empty, 2, ordinary)).toBeNull()
    const patch = recordLinkedVisit(empty, 2, played)!
    expect(patch.slideVisitedLinks).toEqual({ 2: ['15'] })
    expect(isVisitedLink(patch, 2, played)).toBe(true)
    expect(recordLinkedVisit(patch, 2, played)).toBeNull()
    expect(isVisitedLink(patch, 2, ordinary)).toBe(false)
    expect(visitedLinkCrops({ ...patch, slideLinks: { 2: [played, ordinary] } }, 2)).toEqual([{ page: 2, rect }])
  })

  it('retains visited cells across navigation but clears them for a fresh take', () => {
    const store = new StateStore()
    store.patch({ fileKind: 'pptx', currentSlide: 2, slideVisitedLinks: { 2: ['15'] } })
    store.patch({ currentSlide: 4 })
    store.patch({ currentSlide: 2 })
    expect(store.get().slideVisitedLinks).toEqual({ 2: ['15'] })
    store.patch({ slideMedia: [] })
    expect(store.get().slideVisitedLinks).toBeUndefined()
  })
})
