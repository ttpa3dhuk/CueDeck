import { describe, expect, it } from 'vitest'
import { initialSlideVideo, slideAudioAdvancePatch, validSlideAudioCue } from '../src/shared/slide-video'
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

describe('PPTX audio cue formats', () => {
  const cue = { file: 'media1.m4a', volume: 1, loop: false, trigger: 'enter' as const }
  it('accepts embedded M4A and WAV cues and rejects paths outside the media cache', () => {
    expect(validSlideAudioCue(cue)).toBe(true)
    expect(validSlideAudioCue({ ...cue, file: 'transition.wav' })).toBe(true)
    expect(validSlideAudioCue({ ...cue, file: 'cue.mp3' })).toBe(true)
    expect(validSlideAudioCue({ ...cue, file: '../transition.wav' })).toBe(false)
    expect(validSlideAudioCue({ ...cue, file: 'sound.aac' })).toBe(false)
  })
  it('validates the authored advance group index', () => {
    expect(validSlideAudioCue({ ...cue, trigger: 'advance', step: 1 })).toBe(true)
    expect(validSlideAudioCue({ ...cue, trigger: 'advance', step: 0 })).toBe(false)
    expect(validSlideAudioCue({ ...cue, trigger: 'advance', step: 1.5 })).toBe(false)
  })
})

describe('PPTX audio-only advance', () => {
  it('consumes the matching click group once and emits an audio event without navigating', () => {
    const cue = { file: 'media3.m4a', volume: 1, loop: false, trigger: 'advance' as const, step: 1 }
    const state = { fileKind: 'pptx' as const, pdfSha1: 'deck', currentSlide: 3, slideMedia: [
      { slide: 3, kind: 'audio' as const, file: cue.file, rect: { x: 0, y: 0, w: 1, h: 1 }, audio: [cue] },
    ], slideAdvanceStep: undefined, takeTransition: { id: 'take', durationMs: 0, scope: 'slide' as const } }
    const patch = slideAudioAdvancePatch(state, 'click-1', 123)!
    expect(patch).toEqual({ slideAdvanceStep: 1, slideAudioClick: {
      id: 'click-1', sha: 'deck', slide: 3, takeId: 'take', at: 123, cues: [cue],
    } })
    expect(slideAudioAdvancePatch({ ...state, slideAdvanceStep: 1 }, 'click-2', 124)).toBeNull()
    expect(slideAudioAdvancePatch({ ...state, fileKind: 'pdf' }, 'click-3', 125)).toBeNull()
  })
})
