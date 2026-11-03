import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import ts from 'typescript'

// Execute the production handlers with a native-video double. This catches the
// empty-path branch and stale path identity without booting Electron's UI.
const source = readFileSync(new URL('../src/renderer/presenter/main.ts', import.meta.url), 'utf8')
function section(from: string, to: string): string { return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))) }
function harness() {
  const video = { src: 'old.mp4', paused: false,
    pause: vi.fn(function (this: { paused: boolean }) { this.paused = true }),
    removeAttribute: vi.fn(function (this: { src: string }) { this.src = '' }), load: vi.fn(), classList: { add: vi.fn() } }
  const d: Record<string, any> = {
    currentVideo: video, releaseProgramVideo: vi.fn(), disposeCurrentImage: vi.fn(),
    takeFade: { begin: vi.fn(), cancel: vi.fn(), reveal: vi.fn() }, isOperator: true,
    showBanner: vi.fn(), t: (x: string) => x, applyState: vi.fn(), applyProgramLive: vi.fn(),
    applyPreviewLive: vi.fn(), attachMeters: vi.fn(), handlePreviewChange: vi.fn(async () => {}),
    loadCurrentFile: vi.fn(async () => {}), renderCurrent: vi.fn(async () => {}),
    updateMediaOverlay: vi.fn(), getState: () => d.current, programFrameReady: () => true,
  }
  const js = ts.transpileModule(`
    const { ${Object.keys(d).join(', ')} } = deps;
    let prevFilePath: string | null = null, prevSlide = 0, programLoadGeneration = 0;
    let docLoaded = true, lastRenderedSlide = 3;
    ${section('function unloadCurrentVideo()', '// ── Слайд-видео')}
    ${section('async function handleStateChange(', 'async function openPdf(')}
    return { handleStateChange, status: () => ({ prevFilePath, programLoadGeneration, docLoaded, lastRenderedSlide }) };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const api = new Function('deps', js)(d)
  return { d, video, api, async apply(path: string | null, patch: unknown = { pdfPath: path }) {
    d.current = { pdfPath: path, fileKind: path ? 'video' : null, currentSlide: 1, preview: { path: null, sha1: null } }
    await api.handleStateChange(d.current, patch)
  } }
}

it('empty program releases native decoder/mirror and invalidates pending loads', async () => {
  const h = harness()
  await h.apply('old.mp4')
  await h.apply(null)
  expect(h.video.paused).toBe(true)
  expect(h.video.src).toBe('')
  expect(h.d.releaseProgramVideo).toHaveBeenCalledWith(h.video)
  expect(h.video.load).toHaveBeenCalledOnce()
  expect(h.api.status()).toMatchObject({ prevFilePath: null, programLoadGeneration: 1, docLoaded: false, lastRenderedSlide: -1 })
  expect(h.d.takeFade.cancel).toHaveBeenCalled()
})
it('reopening the same path after New reloads it; repeated empty patches do not release again', async () => {
  const h = harness()
  await h.apply('old.mp4')
  await h.apply(null)
  await h.apply(null)
  expect(h.video.load).toHaveBeenCalledOnce()
  await h.apply('old.mp4')
  expect(h.d.loadCurrentFile).toHaveBeenCalledTimes(2)
  expect(h.api.status().prevFilePath).toBe('old.mp4')
})
it('ordinary nonempty TAKE retains transition ownership instead of running empty-deck disposal', async () => {
  const h = harness()
  await h.apply('old.mp4')
  const transition = { id: 'fade', durationMs: 500 }
  await h.apply('next.mp4', { takeTransition: transition, pdfPath: 'next.mp4' })
  expect(h.d.takeFade.begin).toHaveBeenCalledWith(transition, false)
  expect(h.d.releaseProgramVideo).not.toHaveBeenCalled()
  expect(h.video.pause).not.toHaveBeenCalled()
})
