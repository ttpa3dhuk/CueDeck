import { describe, it, expect } from 'vitest'
import { isLiveUri, makeLiveUri, parseLiveUri, liveDisplayName, liveFitFor } from '../src/shared/live'

describe('live URI', () => {
  it('round-trip с аудио и без', () => {
    const withAudio = { videoLabel: 'AVMatrix USB Capture', audioLabel: 'AVMatrix Audio' }
    expect(parseLiveUri(makeLiveUri(withAudio))).toEqual(withAudio)

    const noAudio = { videoLabel: 'Cam Link 4K', audioLabel: null }
    expect(parseLiveUri(makeLiveUri(noAudio))).toEqual(noAudio)
  })

  it('метки со спецсимволами не рвут разбор', () => {
    // Реальные метки бывают с скобками, плюсом, амперсандом и кириллицей.
    const src = { videoLabel: 'Камера (USB 3.0 & HDMI) #2 + capture', audioLabel: 'Вход = 1/2' }
    const uri = makeLiveUri(src)
    expect(parseLiveUri(uri)).toEqual(src)
  })

  it('опознаёт живой путь и не трогает обычные файлы', () => {
    expect(isLiveUri(makeLiveUri({ videoLabel: 'X', audioLabel: null }))).toBe(true)
    expect(isLiveUri('/Users/a/deck.pdf')).toBe(false)
    expect(isLiveUri('C:\\Decks\\live.pdf')).toBe(false)
    expect(isLiveUri(null)).toBe(false)
  })

  it('битый живой путь разбирается в null, а не бросает', () => {
    expect(parseLiveUri('live://device')).toBeNull()
    expect(parseLiveUri('live://device?a=only-audio')).toBeNull()
    expect(parseLiveUri('/Users/a/deck.pdf')).toBeNull()
  })

  it('режим вписывания ищется по id, потом по пути, иначе дефолт', () => {
    const a = makeLiveUri({ videoLabel: 'A', audioLabel: null })
    const b = makeLiveUri({ videoLabel: 'B', audioLabel: null })
    const playlist = [
      { id: '1', filePath: a, liveFit: 'cover' as const },
      { id: '2', filePath: b, liveFit: 'fill' as const },
    ]

    expect(liveFitFor(playlist, '1', a)).toBe('cover')
    // id есть, но путь у записи уже другой (перенастроили устройства) —
    // не должны молча отдать чужой режим, ищем по пути.
    expect(liveFitFor(playlist, '1', b)).toBe('fill')
    // Деск пережил очистку currentPlaylistId — находим по пути.
    expect(liveFitFor(playlist, null, b)).toBe('fill')
    // Запись удалили из плейлиста, а источник ещё в эфире.
    expect(liveFitFor(playlist, null, 'live://device?v=Z')).toBe('contain')
    expect(liveFitFor(playlist, null, null)).toBe('contain')
    // Старый сохранённый плейлист без поля liveFit.
    expect(liveFitFor([{ id: '3', filePath: a }], '3', a)).toBe('contain')
  })

  it('имя для плейлиста берётся из метки камеры', () => {
    const uri = makeLiveUri({ videoLabel: 'Cam Link 4K', audioLabel: null })
    expect(liveDisplayName(uri)).toBe('Cam Link 4K')
    // Битый путь не должен оставлять запись без названия.
    expect(liveDisplayName('live://device')).toBe('Внешний вход')
  })
})
