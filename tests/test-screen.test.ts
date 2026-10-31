import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { startupTestScreenAllowed, testScreenVisible } from '../src/shared/test-screen'
import { shouldMute } from '../src/renderer/shared/video'

const empty = { playlist: [], lastPath: null, projectPath: null, keyVisualPath: null }
const entry = { kind: 'pptx' as const, displayName: '', speakerName: '', id: 'missing', filePath: '/missing.pptx', fileName: 'missing.pptx', durationMs: 0 }
describe('test screen startup and output safety', () => {
  it('starts black before any startup eligibility decision', () => {
    expect(testScreenVisible(new StateStore().get())).toBe(false)
    expect(startupTestScreenAllowed(empty)).toBe(true)
    for (const saved of [{ ...empty, playlist: [entry] }, { ...empty, lastPath: '/lost.mp4' },
      { ...empty, projectPath: '/show.pdpres' }, { ...empty, keyVisualPath: '/kv.png' }]) {
      expect(startupTestScreenAllowed(saved)).toBe(false)
    }
  })
  it.each(['playlist', 'program', 'preview', 'project', 'keyvisual'])('retires auto screen atomically on %s and never resurrects it', kind => {
    const store = new StateStore()
    store.patch({ testScreen: { ...store.get().testScreen, automatic: true } })
    expect(testScreenVisible(store.get())).toBe(true)
    const patches: any[] = []
    store.onChange((state, patch) => patches.push({ visible: testScreenVisible(state), patch }))
    if (kind === 'playlist') store.patch({ playlist: [entry] })
    if (kind === 'program') store.patch({ pdfPath: '/show.pdf' })
    if (kind === 'preview') store.patch({ preview: { ...store.get().preview, path: '/show.pdf' } })
    if (kind === 'project') store.patch({ projectPath: '/show.pdpres' })
    if (kind === 'keyvisual') store.patch({ keyVisualPath: '/show.png' })
    expect(store.get().testScreen.automatic).toBe(false)
    expect(patches[0]).toMatchObject({ visible: false, patch: { testScreen: { automatic: false } } })
    store.patch({ playlist: [], pdfPath: null, preview: { ...store.get().preview, path: null }, projectPath: null, keyVisualPath: null })
    expect(testScreenVisible(store.get())).toBe(false)
  })
  it('cannot enable automatic mode over existing or missing content', () => {
    const store = new StateStore()
    store.patch({ playlist: [entry] })
    store.patch({ testScreen: { ...store.get().testScreen, automatic: true } })
    expect(testScreenVisible(store.get())).toBe(false)
  })
  it('manual mode preserves content and video clock, mutes output, blackout takes priority', () => {
    const store = new StateStore()
    store.patch({ pdfPath: '/show.mp4', fileKind: 'video', video: { playing: true, anchorSec: 10, anchorAt: 1000, durationSec: 60, muted: false } })
    const video = store.get().video
    store.patch({ testScreen: { ...store.get().testScreen, manual: true } })
    expect(testScreenVisible(store.get())).toBe(true)
    expect(shouldMute(store.get(), 'operator')).toBe(true)
    store.patch({ blackout: true })
    expect(testScreenVisible(store.get())).toBe(false)
    store.patch({ blackout: false, testScreen: { ...store.get().testScreen, manual: false } })
    expect(store.get().pdfPath).toBe('/show.mp4')
    expect(store.get().video).toBe(video)
    expect(shouldMute(store.get(), 'operator')).toBe(false)
    expect(testScreenVisible(store.get())).toBe(false)
  })

})
