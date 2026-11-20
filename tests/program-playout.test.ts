import type { NativeImage } from 'electron'
import { describe, expect, it } from 'vitest'
import { ProgramAudioTimeline, ProgramVideoTimeline, isProgramTransition } from '../src/main/program-playout'
import type { AppState } from '../src/shared/types'

function image(id: number, width = 32, height = 18): NativeImage {
  return { id, isEmpty: () => false, getSize: () => ({ width, height }) } as unknown as NativeImage
}

function pcm(value: number, frames = 960) {
  const data = new Float32Array(frames * 2)
  data.fill(value, 0, frames)
  data.fill(-value, frames)
  return { sampleRate: 48000, channels: 2, frames, data }
}

describe('shared network program playout', () => {
  it('counts each accepted capture once for each subscriber, independent of selection', () => {
    const timeline = new ProgramVideoTimeline()
    const ndi = timeline.consumer(), omt = timeline.consumer()
    timeline.push(image(1), 0)
    timeline.push(image(2), 20)
    expect(ndi.takeSourceCaptures()).toBe(2)
    expect(omt.takeSourceCaptures()).toBe(2)
    expect(ndi.takeSourceCaptures()).toBe(0)
    // The other transport may select or repeat; that is not an input event.
    expect(omt.next(30, 100)?.id).toBeGreaterThan(0)
    expect(omt.takeSourceCaptures()).toBe(0)
    timeline.push(image(3), 120)
    expect(ndi.takeSourceCaptures()).toBe(1)
    expect(omt.takeSourceCaptures()).toBe(1)
  })

  it('warms up before playout and lets independent transports read the same static last frame', () => {
    const timeline = new ProgramVideoTimeline()
    const ndi = timeline.consumer(), omt = timeline.consumer()
    timeline.push(image(1), 0)
    expect(ndi.next(30, 60)).toBeNull()
    expect(ndi.next(30, 80)?.image).toBe(omt.next(25, 80)?.image)
    expect(ndi.next(30, 1000)).toBeNull()
  })

  it('limits ordinal skips in a callback burst, then abandons old frames after a native stall', () => {
    const timeline = new ProgramVideoTimeline(), ndi = timeline.consumer()
    timeline.push(image(1), 0)
    expect((ndi.next(30, 80)?.image as any).id).toBe(1)
    for (let id = 2; id <= 7; id++) timeline.push(image(id), 80 + id)
    expect((ndi.next(30, 180)?.image as any).id).toBe(3)
    expect((ndi.next(30, 185)?.image as any).id).toBe(5)
    for (let id = 8; id <= 12; id++) timeline.push(image(id), 400 + id * 20)
    const recovered = ndi.next(30, 680)
    expect((recovered?.image as any).id).toBeGreaterThanOrEqual(10)
    expect(recovered?.id).toBeGreaterThan(5)
  })

  it('shares one bounded high-resolution queue, including at 5K 60 Hz', () => {
    const timeline = new ProgramVideoTimeline(), cursor = timeline.consumer()
    for (let id = 0; id < 40; id++) timeline.push(image(id, 5120, 2880), id * 1000 / 60)
    const selected = cursor.next(60, 40 * 1000 / 60)
    expect(selected).not.toBeNull()
    expect((selected!.image as any).id).toBeLessThan(39)
  })

  it('combines contiguous planar PCM after short IPC jitter and never sends a catch-up burst', () => {
    const timeline = new ProgramAudioTimeline()
    timeline.push(pcm(1), 20)
    timeline.push(pcm(2), 40)
    timeline.push(pcm(3), 60)
    expect(timeline.due(100)).toBeNull()
    const packet = timeline.due(165)!
    expect(packet.frames).toBe(2880)
    expect([...packet.data.subarray(0, 960)]).toEqual(Array(960).fill(1))
    expect(packet.data[960]).toBe(2)
    expect(packet.data[2880]).toBe(-1)
    expect(packet.data[3840]).toBe(-2)
    expect(timeline.nextDueAt()).toBeNull()
  })

  it('clears old segments only on explicit stop/restart', () => {
    const video = new ProgramVideoTimeline(), audio = new ProgramAudioTimeline()
    const cursor = video.consumer()
    video.push(image(1), 0); audio.push(pcm(1), 20)
    video.reset(); audio.reset()
    expect(cursor.next(30, 200)).toBeNull()
    expect(audio.due(200)).toBeNull()
    video.push(image(2), 220)
    expect((cursor.next(30, 300)?.image as any).id).toBe(2)
  })

  it('plays through a delayed TAKE cut and never selects the old segment afterwards', () => {
    const timeline = new ProgramVideoTimeline(), cursor = timeline.consumer()
    timeline.push(image(1), 0)
    expect((cursor.next(30, 80)?.image as any).id).toBe(1)
    timeline.push(image(2), 90)
    timeline.markCut(100)
    timeline.push(image(3), 105)
    expect(cursor.cutIsDue(179)).toBe(false)
    expect((cursor.next(30, 179)?.image as any).id).toBe(2)
    expect(cursor.cutIsDue(180)).toBe(true)
    expect(cursor.next(30, 180)).toBeNull()
    expect((cursor.next(30, 185)?.image as any).id).toBe(3)
    expect(cursor.cutIsDue(186)).toBe(false)
  })

  it('does not cut a static picture for mute or repeated state values', () => {
    const before = { pdfPath: '/slide.pdf', pdfSha1: 'sha', currentSlide: 1, blackout: false,
      video: { seekSeq: 7, muted: false } } as AppState
    expect(isProgramTransition({ sourceMuted: true }, before)).toBe(false)
    expect(isProgramTransition({ video: { ...before.video, muted: true } }, before)).toBe(false)
    expect(isProgramTransition({ currentSlide: 1, blackout: false, video: { ...before.video } }, before)).toBe(false)
    expect(isProgramTransition({ currentSlide: 2 }, before)).toBe(true)
    expect(isProgramTransition({ video: { ...before.video, seekSeq: 8 } }, before)).toBe(true)
  })

  it('recovers a moving TAKE near live after a stall but preserves a single static frame', () => {
    const moving = new ProgramVideoTimeline(), cursor = moving.consumer()
    moving.push(image(0), 0)
    cursor.next(30, 80)
    moving.markCut(100)
    for (let at = 120, id = 1; at <= 320; at += 20, id++) moving.push(image(id), at)
    const recovered = cursor.next(30, 400)!
    expect((recovered.image as any).id).toBe(5) // oldest post-cut frame still within 200 ms

    const staticTimeline = new ProgramVideoTimeline(), staticCursor = staticTimeline.consumer()
    staticTimeline.push(image(0), 0)
    staticCursor.next(30, 80)
    staticTimeline.markCut(100)
    staticTimeline.push(image(1), 120)
    expect((staticCursor.next(30, 400)?.image as any).id).toBe(1)
  })
})
