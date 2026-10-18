import { describe, expect, it } from 'vitest'
import { initialSlideVideo } from '../src/shared/slide-video'
import type { SlideMedia } from '../src/shared/types'
const media: SlideMedia[] = [
  {slide: 1, file: 'background.mov', rect: {x:0,y:0,w:1,h:1}, autoPlay:true, loop:true},
  {slide: 2, file: 'click.mp4', rect: {x:0,y:0,w:1,h:1}, autoPlay:false},
]
describe('PPTX program slide entry', () => {
  it('starts and loops a video background from zero, preserving mute', () => {
    expect(initialSlideVideo('pptx', media, 1, true, 123)).toEqual({video:{playing:true,anchorSec:0,anchorAt:123,durationSec:0,muted:true},videoLoop:true})
  })
  it('keeps authored click-to-play paused', () => {
    expect(initialSlideVideo('pptx', media, 2, false, 123).video.playing).toBe(false)
  })
  it('resets looping and playback when leaving the video slide', () => {
    const r=initialSlideVideo('pptx',media,3,false,123)
    expect(r.video.playing).toBe(false);expect(r.videoLoop).toBe(false)
  })
  it('does not inherit a previous deck policy or guess autoplay for legacy metadata', () => {
    expect(initialSlideVideo('pdf',media,1,false).video.playing).toBe(false)
    expect(initialSlideVideo('pptx',[{slide:1,file:'old.mp4',rect:{x:0,y:0,w:1,h:1}}],1,false).video.playing).toBe(false)
  })
})
