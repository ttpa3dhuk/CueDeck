import { afterEach, expect, it, vi } from 'vitest'
import { TakeFade } from '../src/renderer/shared/take-fade'
import type { PptxSlideTransition } from '../src/shared/pptx-transition'

afterEach(() => vi.unstubAllGlobals())

async function render(effect: Exclude<PptxSlideTransition, number>, viewport = { width: 700, height: 350 }, letterboxed = false) {
  const rect = { left: 0, top: 0, width: viewport.width, height: viewport.height,
    right: viewport.width, bottom: viewport.height }
  let time = 0
  const calls: Array<{ t: number; op: string; args: unknown[] }> = []
  const record = (op: string) => (...args: unknown[]) => calls.push({ t: time, op, args })
  class Context {
    globalAlpha = 1
    scale = record('scale'); translate = record('translate'); fillRect = record('fillRect')
    drawImage = record('drawImage'); save = record('save'); restore = record('restore')
    beginPath = record('beginPath'); rect = record('rect'); clip = record('clip'); arc = record('arc')
  }
  class Canvas {
    width = letterboxed ? 1600 : viewport.width
    height = letterboxed ? 900 : viewport.height
    clientWidth = viewport.width
    className = ''; dataset: Record<string, string> = {}; style = { clipPath: '' }
    classList = { contains: () => false }; context = new Context()
    getBoundingClientRect = () => rect
    getContext = () => this.context
    remove = vi.fn()
  }
  class Video {
    videoWidth = viewport.width; videoHeight = viewport.height; paused = true; readyState = 4
    getBoundingClientRect = () => rect
  }
  vi.stubGlobal('HTMLCanvasElement', Canvas)
  vi.stubGlobal('HTMLImageElement', class {})
  vi.stubGlobal('HTMLVideoElement', Video)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible', objectFit: letterboxed ? 'contain' : 'fill', clipPath: 'none', opacity: '1' }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    time += 500
    queueMicrotask(() => callback(time))
    return 1
  })
  const created: Canvas[] = []
  vi.stubGlobal('document', { createElement: () => { const canvas = new Canvas(); created.push(canvas); return canvas } })
  const old = new Canvas(), incoming = letterboxed ? new Canvas() : new Video()
  let sources: Array<Canvas | Video> = [old]
  const host = { getBoundingClientRect: () => rect, append: vi.fn() }
  const fade = new TakeFade(host as unknown as HTMLElement, () => sources as unknown as HTMLCanvasElement[])
  const event = { id: effect.kind, scope: 'slide' as const, durationMs: effect.durationMs, slideEffect: effect }
  fade.begin(event)
  sources = [incoming]
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time)
  try { await fade.reveal(event, () => true) }
  finally { clock.mockRestore(); fade.cancel() }
  return { calls, old: created[0], incoming, overlay: created[1], combFrame: created[2] }
}

it.each([
  { kind: 'comb', direction: 'horz', durationMs: 1000 },
  { kind: 'comb', direction: 'vert', durationMs: 1000 },
  { kind: 'doors', direction: 'vert', durationMs: 1000 },
  { kind: 'doors', direction: 'horz', durationMs: 1000 },
  { kind: 'circle', durationMs: 1000 },
] as const)('renders outgoing and incoming video through $kind', async effect => {
  const { calls, old, incoming, overlay } = await render(effect)
  expect(overlay.dataset.transition).toBe(effect.kind)
  expect(overlay.dataset.progress).toBe('1')
  expect(overlay.remove).toHaveBeenCalledOnce()
  expect(calls.some(call => call.t === 500 && call.op === 'drawImage' && call.args[0] === old)).toBe(true)
  expect(calls.some(call => call.t === 500 && call.op === 'drawImage' && call.args[0] === incoming)).toBe(true)
  if (effect.kind === 'comb') {
    expect(calls.filter(call => call.t === 500 && call.op === 'drawImage' && call.args[0] === incoming)).toHaveLength(1)
    const stripes = calls.filter(call => call.t === 500 && call.op === 'rect' &&
      (effect.direction === 'horz' ? call.args[3] === 50 : call.args[2] === 100))
    expect(stripes).toHaveLength(7)
    const moves = calls.filter(call => call.t === 500 && call.op === 'translate')
    expect(Number(moves[0].args[effect.direction === 'horz' ? 0 : 1])).toBeGreaterThan(0)
    expect(moves.some(call => Number(call.args[0]) < 0 || Number(call.args[1]) < 0)).toBe(true)
    expect(moves.some(call => Number(call.args[0]) > 0 || Number(call.args[1]) > 0)).toBe(true)
  } else if (effect.kind === 'doors') {
    expect(calls.some(call => call.t === 500 && call.op === 'scale' && call.args[0] === 0.775)).toBe(true)
  } else {
    const arc = calls.find(call => call.t === 500 && call.op === 'arc')!
    expect(arc.args.slice(0, 2)).toEqual([350, 175])
    expect(arc.args[2]).toBeCloseTo(Math.hypot(700, 350) / 4)
  }
})

it.each([
  { viewport: { width: 1800, height: 510 }, area: { x: 446.66666666666663, y: 0, width: 906.6666666666667, height: 510 } },
  { viewport: { width: 700, height: 700 }, area: { x: 0, y: 153.125, width: 700, height: 393.75 } },
])('moves only active slide pixels in Comb with $viewport.width × $viewport.height letterbox', async ({ viewport, area }) => {
  const { calls, old, combFrame } = await render({ kind: 'comb', direction: 'horz', durationMs: 1000 }, viewport, true)
  for (const source of [old, combFrame]) {
    const draws = calls.filter(call => call.t === 500 && call.op === 'drawImage' && call.args[0] === source)
    expect(draws).toHaveLength(7)
    for (const draw of draws) {
      expect(draw.args).toHaveLength(9)
      expect(draw.args[1]).toBeCloseTo(area.x)
      expect(draw.args[2]).toBeCloseTo(area.y)
      expect(draw.args[3]).toBeCloseTo(area.width)
      expect(draw.args[4]).toBeCloseTo(area.height)
      expect(draw.args[5]).toBeCloseTo(area.x)
      expect(draw.args[6]).toBeCloseTo(area.y)
      expect(draw.args[7]).toBeCloseTo(area.width)
      expect(draw.args[8]).toBeCloseTo(area.height)
    }
  }
})
