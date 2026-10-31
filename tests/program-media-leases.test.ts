import { describe, expect, it } from 'vitest'
import { ProgramMediaLeases } from '../src/main/program-media-leases'

describe('outgoing media during Fade', () => {
  it('keeps the original source after preview changes, then expires it', () => {
    let now = 0
    const leases = new ProgramMediaLeases((sha, file) => `/cache/${sha}/${file}`, () => now)
    const source = { pdfPath: '/first.mp4', pdfSha1: 'first', fileKind: 'video' as const, slideMedia: [] }
    leases.retain(source)
    source.pdfPath = '/different.mp4'
    expect(leases.resolve('first')).toBe('/first.mp4')
    expect(leases.resolve('unknown')).toBeNull()
    now = 15_000
    expect(leases.resolve('first')).toBeNull()
  })

  it('only serves manifested slide media and rejects path traversal', () => {
    const leases = new ProgramMediaLeases((sha, file) => `/cache/${sha}/${file}`)
    leases.retain({ pdfPath: '/deck.pptx', pdfSha1: 'deck', fileKind: 'pptx', slideMedia: [
      { slide: 2, file: 'movie.mp4', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { slide: 3, file: '../secret.mp4', rect: { x: 0, y: 0, w: 1, h: 1 } },
    ] })
    expect(leases.resolve('deck', 'movie.mp4')).toBe('/cache/deck/movie.mp4')
    for (const file of ['absent.mp4', '../secret.mp4', '..\\secret.mp4', '/movie.mp4']) {
      expect(leases.resolve('deck', file)).toBeNull()
    }
    expect(leases.resolve('deck')).toBeNull()
  })

  it('bounds retained sources during rapid repeated takes', () => {
    const leases = new ProgramMediaLeases(() => '')
    for (let i = 0; i < 6; i++) leases.retain({ pdfPath: `/${i}.mp4`, pdfSha1: String(i), fileKind: 'video', slideMedia: [] })
    expect(leases.resolve('0')).toBeNull()
    expect(leases.resolve('1')).toBeNull()
    expect(leases.resolve('2')).toBe('/2.mp4')
    expect(leases.resolve('5')).toBe('/5.mp4')
  })
})
