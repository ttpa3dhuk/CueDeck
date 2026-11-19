import { afterEach, expect, it, vi } from 'vitest'
import { containedBox } from '../src/renderer/shared/element-box'
import { TakeFade } from '../src/renderer/shared/take-fade'
afterEach(() => vi.unstubAllGlobals())

it('fits a 16:9 slide into a wide and a tall viewport while preserving fractional coordinates', () => {
  expect(containedBox({left: 10, top: 20, width: 1800, height: 450}, 1600, 900))
    .toEqual({left: 510, top: 20, width: 800, height: 450, right: 1310, bottom: 470})
  expect(containedBox({left: 0.5, top: 1.5, width: 800, height: 1000}, 1600, 900))
    .toEqual({left: 0.5, top: 276.5, width: 800, height: 450, right: 800.5, bottom: 726.5})
  expect(containedBox({left: 3, top: 4, width: 800, height: 450}, 1600, 900))
    .toEqual({left: 3, top: 4, width: 800, height: 450, right: 803, bottom: 454})
})

it('clips the animation to the slide and plays Push through the normal transition entry point', async () => {
  const rect = {left: 0, top: 0, width: 1800, height: 450, right: 1800, bottom: 450}
  const ctx = {scale: vi.fn(),fillRect: vi.fn(),drawImage: vi.fn(),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),translate:vi.fn()}
  class Canvas {
    width=3600; height=2025; style={clipPath:''};classList={contains:()=>false}
    dataset: Record<string, string> = {}; clientWidth = rect.width
    getBoundingClientRect=()=>rect;getContext=()=>ctx;remove=vi.fn()
  }
  vi.stubGlobal('HTMLCanvasElement',Canvas);vi.stubGlobal('HTMLImageElement',class {});vi.stubGlobal('HTMLVideoElement',class {})
  vi.stubGlobal('devicePixelRatio',2);vi.stubGlobal('cancelAnimationFrame',vi.fn())
  vi.stubGlobal('getComputedStyle',()=>({display:'block',objectFit:'contain',clipPath:'none',opacity:'1'}))
  const frame=new Canvas();vi.stubGlobal('document',{createElement:()=>frame})
  const fade=new TakeFade({getBoundingClientRect:()=>rect,append:vi.fn()} as unknown as HTMLElement,[new Canvas() as unknown as HTMLCanvasElement])
  fade.begin({id:'letterbox',scope:'slide',durationMs:500,buildAnimation:{kind:'native-frames',durationMs:500,rect:{x:0,y:0,w:0.5,h:1},framesFile:'frames.pdf',frameCount:16}})
  const insets=frame.style.clipPath.match(/[\d.]+/g)!.map(Number)
  expect(insets).toEqual([0,898,0,498])
  fade.cancel()

  const pushFrame = new Canvas()
  vi.stubGlobal('document',{createElement:vi.fn().mockReturnValueOnce(new Canvas()).mockReturnValueOnce(pushFrame)})
  const event = {id:'push',scope:'slide',durationMs:1000,pushDirection:'u'} as const
  fade.begin(event)
  let time = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    time += 500
    queueMicrotask(() => callback(time))
    return 1
  })
  try {
    await fade.reveal(event, () => true)
    expect(pushFrame.dataset.transition).toBe('push')
    expect(ctx.translate.mock.calls.map(([, y]) => Math.abs(y))).toEqual([450, 225, 0])
    expect(pushFrame.dataset.progress).toBe('1')
    expect(pushFrame.remove).toHaveBeenCalledOnce()
  } finally {
    clock.mockRestore()
    fade.cancel()
  }
})
