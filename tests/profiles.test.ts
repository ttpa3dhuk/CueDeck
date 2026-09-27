import { describe, expect, it } from 'vitest'
import {
  GROUP_KEYS,
  PROFILE_GROUPS,
  cleanName,
  mergeSettings,
  sanitizeGroups,
  parseProfileFile,
  profileFileName,
  sanitizeProfileList,
  sanitizeSettings,
  serializeProfileFile,
  uniqueProfileName,
} from '../src/main/profile-core'
import { DEFAULT_REMOTE_SETTINGS, type VenueProfile } from '../src/shared/types'

const full = sanitizeSettings({
  layout: 'presenter-audience',
  audienceWindowed: true,
  audioMain: { id: 'abc', label: 'Focusrite 2i2' },
  audioPreview: null,
  timerMode: 'stopwatch',
  timerPosition: 'free',
  timerScale: 2.05,
  timerFree: { x: 0.8, y: 0.2 },
  timerColor: '#ff0000',
  timerPresets: [5, 10, 15, 20],
  speakerLayout: { sidebarPct: 40, nextPct: null },
  speakerMsgLayout: { pos: { x: 0.3, y: 0.1 }, scale: 1.5 },
  speakerMsgPresets: ['Заканчивайте', '', ''],
  clickerGlobal: true,
  remote: { enabled: true, httpPort: 9500, oscPort: 9501, lan: true, companionPush: false, companionHost: '10.0.0.5:8000' },
  midiInputs: ['X-Touch', 'X-Touch', ''],
})

describe('sanitizeSettings', () => {
  it('сохраняет корректные значения', () => {
    expect(full.layout).toBe('presenter-audience')
    expect(full.audioMain).toEqual({ id: 'abc', label: 'Focusrite 2i2' })
    expect(full.timerPosition).toBe('free')
    expect(full.timerColor).toBe('#ff0000')
    expect(full.speakerMsgLayout.pos).toEqual({ x: 0.3, y: 0.1 })
    expect(full.remote.httpPort).toBe(9500)
    expect(full.remote.companionHost).toBe('10.0.0.5:8000')
    expect(full.midiInputs).toEqual(['X-Touch'])
  })

  it('мусор → умолчания свежей установки', () => {
    const s = sanitizeSettings({
      layout: 'huge',
      timerScale: 'big',
      timerColor: 'red',
      timerFree: 'x',
      audioMain: { id: 'x', label: '   ' },
      remote: { httpPort: 80, companionHost: 'http://evil/path' },
      timerPosition: null,
    })
    expect(s.layout).toBe('operator-speaker-audience')
    expect(s.timerScale).toBe(1)
    expect(s.timerColor).toBeNull()
    expect(s.timerFree).toEqual({ x: 0.85, y: 0.12 })
    expect(s.audioMain).toBeNull()
    expect(s.remote.httpPort).toBe(DEFAULT_REMOTE_SETTINGS.httpPort)
    expect(s.remote.companionHost).toBe(DEFAULT_REMOTE_SETTINGS.companionHost)
    expect(s.timerPosition).toBe('top-right')
  })

  it('зажимает числа в пределы', () => {
    const s = sanitizeSettings({ timerScale: 99, timerFree: { x: -1, y: 5 }, speakerLayout: { sidebarPct: 5, nextPct: 99 } })
    expect(s.timerScale).toBe(4)
    expect(s.timerFree).toEqual({ x: 0, y: 1 })
    expect(s.speakerLayout).toEqual({ sidebarPct: 18, nextPct: 85 })
  })

  it('не берёт пустые списки пресетов за «всё пусто»', () => {
    expect(sanitizeSettings({}).timerPresets).toEqual([])
    expect(sanitizeSettings({}).speakerMsgPresets).toEqual([])
  })
})

describe('файл .cueprofile', () => {
  const p: VenueProfile = {
    id: 'local-id',
    name: 'Крокус, зал 2',
    groups: ['prompter', 'presets'],
    savedAt: '2026-09-28T10:00:00.000Z',
    settings: full,
  }

  it('туда и обратно без потерь', () => {
    const text = serializeProfileFile(p, '0.8.0')
    expect(text).not.toContain('local-id')
    const back = parseProfileFile(text, 'file')
    expect(back).toEqual({ ok: true, name: 'Крокус, зал 2', savedAt: p.savedAt, groups: ['prompter', 'presets'], settings: full })
  })

  it('ошибки: не JSON, не профиль, новее программы', () => {
    expect(parseProfileFile('{', 'x')).toEqual({ ok: false, error: 'json' })
    expect(parseProfileFile('{"kind":"project"}', 'x')).toEqual({ ok: false, error: 'kind' })
    expect(parseProfileFile('{"kind":"venue-profile","schemaVersion":99}', 'x')).toEqual({ ok: false, error: 'newer' })
  })

  it('без имени — имя файла', () => {
    const r = parseProfileFile('{"kind":"venue-profile","settings":{}}', 'Зал 3')
    expect(r.ok && r.name).toBe('Зал 3')
  })

  it('имя файла без запрещённых символов', () => {
    expect(profileFileName('Крокус: зал 2/3?')).toBe('Крокус_ зал 2_3_.cueprofile')
    expect(profileFileName('...')).toBe('profile.cueprofile')
  })
})

describe('имена и список', () => {
  it('уникальные имена без регистра', () => {
    expect(uniqueProfileName('Зал', ['Другой'])).toBe('Зал')
    expect(uniqueProfileName('зал', ['Зал', 'Зал (2)'])).toBe('зал (3)')
  })

  it('cleanName', () => {
    expect(cleanName('  Зал\n 2 ')).toBe('Зал 2')
    expect(cleanName('   ')).toBeNull()
    expect(cleanName(5)).toBeNull()
  })

  it('битые записи списка отбрасываются', () => {
    const list = sanitizeProfileList([{ id: 'a', name: 'Ок', settings: {} }, { id: '', name: 'нет id' }, null, 'x'])
    expect(list.map((p) => p.name)).toEqual(['Ок'])
    expect(sanitizeProfileList('мусор')).toEqual([])
  })
})

describe('группы', () => {
  it('каждое поле настроек — ровно в одной группе', () => {
    const keys = PROFILE_GROUPS.flatMap((g) => GROUP_KEYS[g])
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(Object.keys(sanitizeSettings({})).sort())
  })

  it('старый профиль без групп — все группы; мусор отбрасывается', () => {
    expect(sanitizeGroups(undefined)).toEqual([...PROFILE_GROUPS])
    expect(sanitizeGroups(['audio', 'нет', 'screens'])).toEqual(['screens', 'audio'])
    expect(sanitizeProfileList([{ id: 'a', name: 'Старый', settings: {} }])[0].groups).toEqual([...PROFILE_GROUPS])
  })

  it('«Обновить» только пресеты — звук и экраны профиля не трогаются', () => {
    const current = sanitizeSettings({
      layout: 'solo',
      audioMain: { id: 'z', label: 'Другой выход' },
      timerPresets: [1, 2, 3, 4],
      speakerMsgPresets: ['Новое'],
    })
    const merged = mergeSettings(full, current, ['presets'])
    expect(merged.timerPresets).toEqual([1, 2, 3, 4])
    expect(merged.speakerMsgPresets).toEqual(['Новое'])
    expect(merged.layout).toBe('presenter-audience')
    expect(merged.audioMain).toEqual({ id: 'abc', label: 'Focusrite 2i2' })
    expect(merged.timerColor).toBe('#ff0000')
  })
})
