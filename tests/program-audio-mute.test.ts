import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { shouldMute, shouldMuteMix } from '../src/renderer/shared/video'

const presenter = readFileSync(join(__dirname, '../src/renderer/presenter/index.html'), 'utf8')
const main = readFileSync(join(__dirname, '../src/renderer/presenter/main.ts'), 'utf8')

describe('persistent program audio control', () => {
  it('keeps the mute button outside the video-only controls', () => {
    const bar = presenter.split('<section id="program-playback"')[1].split('</section>')[0]
    const videoControls = bar.split('<div id="video-controls"')[1].split('</div>')[0]
    expect(videoControls).not.toContain('id="video-mute"')
    expect(bar).toMatch(/id="current-meter"[^>]*><i><\/i><\/div>\s*<button id="video-mute"/)
    expect(bar).toContain('aria-pressed="false"')
    expect(main.indexOf('videoMuteBtn.textContent')).toBeLessThan(main.indexOf('if (!isVideo) return', main.indexOf('function updateVideoUI')))
    expect(main).toContain("videoMuteBtn!.addEventListener('click', () => window.api.video.toggleMuted())")
  })

  it.each(['pdf', 'pptx', 'image', 'live', 'video'] as const)('M toggles the mix on %s without requiring video', kind => {
    const toggleMuted = vi.fn()
    const source = main.slice(main.indexOf('function dispatchHotkey('), main.indexOf('function toggleAudienceOutput('))
    const dispatch = runInNewContext(ts.transpile(source) + '; dispatchHotkey', {
      getState: () => ({ fileKind: kind }),
      programHasVideo: () => kind === 'video',
      window: { api: { video: { toggleMuted } } },
    }) as (action: string) => void
    dispatch('mute')
    expect(toggleMuted).toHaveBeenCalledOnce()
    expect(main).toContain("if (!settingsModal.classList.contains('hidden') || isTypingTarget(e.target)) return")
    expect(main).toContain("{ id: 'mute', label: t('Эфир: звук вкл / выкл'), def: 'KeyM' }")
  })

  it('mutes the active program route for PPTX audio, video and live input without changing preview', () => {
    const store = new StateStore()
    const previewMuted = store.get().preview.video.muted
    for (const layout of ['solo', 'presenter-audience'] as const) {
      store.patch({ layout, video: { ...store.get().video, muted: true } })
      for (const role of ['operator', 'audience', 'speaker'] as const) {
        expect(shouldMuteMix(store.get(), role)).toBe(true)
        expect(shouldMute(store.get(), role)).toBe(true)
      }
      expect(store.get().preview.video.muted).toBe(previewMuted)
    }
    store.patchVideo({ muted: false })
    expect(shouldMuteMix(store.get(), 'audience')).toBe(false)
  })
})
