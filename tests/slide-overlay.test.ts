import { describe, expect, it } from 'vitest'
import { placeSlideOverlay, slideOverlayGeometry } from '../src/renderer/shared/video'

describe('PowerPoint video geometry', () => {
  it('retains the uncut picture frame', () => {
    expect(slideOverlayGeometry({ x: .1, y: .2, w: .6, h: .5 }, undefined, 1000, 600))
      .toEqual({ x: 100, y: 120, width: 600, height: 300, clip: [0, 0, 0, 0] })
  })
  it('maps the visible video region to the cropped frame, including negative slide offsets', () => {
    const rect = { x: 0, y: -19115 / 10287000, w: 1, h: 9656602 / 10287000 }
    const g = slideOverlayGeometry(rect, { left: 0, top: 0, right: 0, bottom: .06476 }, 1920, 1080)
    expect(g.width).toBe(1920)
    expect(g.y).toBeLessThan(0)
    expect(g.clip[0]).toBeCloseTo(-g.y)
    // The bottom of the visible video matches the slide's picture frame;
    // no extra footer from the uncut MOV may leak below it.
    expect(g.y + g.height - g.clip[2]).toBeCloseTo((rect.y + rect.h) * 1080)
    expect(g.height * (1 - .06476)).toBeCloseTo(rect.h * 1080)
  })
})

it('aligns video with letterboxed canvas pixels in a short operator pane', () => {
  const element = { style: {} } as unknown as HTMLElement
  const canvas = { clientWidth:400, clientHeight:80, width:1600, height:900, offsetLeft:10, offsetTop:20 } as unknown as HTMLElement
  placeSlideOverlay(element, canvas, {x:0,y:0,w:1,h:1})
  expect(parseFloat(element.style.width)).toBeCloseTo(80*16/9)
  expect(parseFloat(element.style.height)).toBeCloseTo(80)
  expect(parseFloat(element.style.left)).toBeCloseTo(10+(400-80*16/9)/2)
  expect(parseFloat(element.style.top)).toBeCloseTo(20)
})
