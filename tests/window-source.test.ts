import { describe, expect, it } from 'vitest'
import { makeLiveUri, parseLiveUri, windowCropRect } from '../src/shared/live'
import { resolveWindowSource } from '../src/shared/window-source'

describe('window capture identity', () => {
  it('preserves a window source through project serialization, without audio', () => {
    const source = { kind: 'window' as const, windowId: 'window:123:0', videoLabel: 'Конкурс & песни?', audioLabel: null }
    expect(parseLiveUri(JSON.parse(JSON.stringify(makeLiveUri(source))))).toEqual(source)
    expect(parseLiveUri('live://other?v=Camera')).toBeNull()
  })
  it('uses the selected window among duplicate titles', () => {
    const sources = [{ id: 'window:1:0', name: 'Zoom' }, { id: 'window:2:0', name: 'Zoom' }]
    expect(resolveWindowSource(sources, 'Zoom', 'window:2:0')).toBe(sources[1])
    expect(resolveWindowSource(sources, 'Zoom', 'window:3:0')).toBeNull()
  })
  it('rebinds a unique title but rejects a recycled id or changed title', () => {
    const sources = [{ id: 'window:1:0', name: 'Mail' }, { id: 'window:2:0', name: 'Contest' }]
    expect(resolveWindowSource(sources, 'Contest', 'window:1:0')).toBe(sources[1])
    expect(resolveWindowSource(sources, 'Meeting', 'window:1:0')).toBeNull()
  })
})

it('persists and clamps crop edges without changing source identity', () => {
  const uri = makeLiveUri({ kind: 'window', videoLabel: 'PowerPoint', audioLabel: null,
    windowCrop: { top: 3.5, right: 200, bottom: -1, left: 1.7 } })
  expect(parseLiveUri(uri)?.windowCrop).toEqual({ top: 3.5, right: 45, bottom: 0, left: 1.7 })
  expect(parseLiveUri(uri)?.videoLabel).toBe('PowerPoint')
})

it('keeps pixel crop units in the project URI', () => {
  const source = { kind: 'window' as const, videoLabel: 'PowerPoint', audioLabel: null,
    windowCrop: { unit: 'px' as const, top: 48, right: 16, bottom: 32, left: 16 } }
  expect(parseLiveUri(makeLiveUri(source))).toMatchObject(source)
})

it('crops exact source pixels and stays valid when the source becomes smaller', () => {
  const crop = { unit: 'px' as const, top: 40, right: 20, bottom: 10, left: 30 }
  expect(windowCropRect(1920, 1080, crop)).toEqual({ x: 30, y: 40, width: 1870, height: 1030 })
  expect(windowCropRect(16, 16, crop)).toEqual({ x: 15, y: 15, width: 1, height: 1 })
})
it('interprets existing percentage crops correctly after migration', () => {
  expect(windowCropRect(1920, 1080, { top: 5, right: 2, bottom: 3, left: 2 }))
    .toEqual({ x: 38, y: 54, width: 1844, height: 994 })
})
