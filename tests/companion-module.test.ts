import { describe, expect, it } from 'vitest'
import { resolveRemote, type RemoteStateView } from '../src/main/remote/commands'
import {
  commandFor,
  commandUrl,
  ON_OFF,
  PREVIEW_CMDS,
  TIMER_CMDS,
  TIMER_MODES,
  TIMER_POSITIONS,
  VIDEO_CMDS,
} from '../companion-module/src/commands'
import { variableNames, variableValues, type CueDeckState } from '../companion-module/src/state'

/**
 * Модуль Companion (companion-module/) живёт отдельным пакетом и не может
 * импортировать таблицу команд CueDeck — поэтому сверка здесь: всё, что модуль
 * способен отправить, CueDeck должен понять.
 */

const video = { playing: true, anchorSec: 0, anchorAt: null, durationSec: 120, muted: false }
const entry = (id: string) =>
  ({ id, kind: 'pdf', filePath: `/x/${id}.pdf`, fileName: `${id}.pdf`, displayName: '', durationMs: 0 }) as unknown as RemoteStateView['playlist'][number]

/** Состояние, в котором любая команда исполнима: ролик в эфире, превью заряжено, спикеры есть и до, и после. */
const busy: RemoteStateView = {
  timer: { durationMs: 600_000, startedAt: null, elapsedMs: 0, running: false, cycles: 0 },
  timerPosition: 'top-right',
  timerPresets: [5, 10, 15, 20],
  speakerMsgPresets: ['Заканчивайте', 'Ближе к микрофону', '', ''],
  fileKind: 'video',
  pdfPath: '/x/a.mp4',
  slideMedia: [],
  currentSlide: 1,
  blackout: false,
  video,
  videoLoop: false,
  playlist: [entry('a'), entry('b'), entry('c'), entry('d')],
  currentPlaylistId: 'c',
  preview: {
    path: '/x/b.mp4',
    sha1: null,
    kind: 'video',
    totalSlides: 0,
    currentSlide: 0,
    notes: {},
    playlistId: 'b',
    slideMedia: [],
    video,
  } as unknown as RemoteStateView['preview'],
  stream: { running: false } as unknown as RemoteStateView['stream'],
}

/** Как server.ts разбирает запрос: `/api/` + сегменты (decodeURIComponent) + `?value=`. */
function viaHttp(url: string) {
  const u = new URL(url, 'http://127.0.0.1:9420')
  const segments = u.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent)
  const value = u.searchParams.get('value')
  return resolveRemote(segments, value !== null ? [value] : [], busy)
}

const each = <T extends string>(list: readonly T[], f: (v: T) => [string, Record<string, unknown>]) => list.map(f)

const ALL: [string, Record<string, unknown>][] = [
  ['program_next', {}],
  ['program_prev', {}],
  ['program_goto', { slide: 3 }],
  ['take', {}],
  ...each(ON_OFF, (mode) => ['blackout', { mode }]),
  ...each(ON_OFF, (mode) => ['stream', { mode }]),
  ...each(VIDEO_CMDS, (cmd) => ['video', { cmd }]),
  ['video_seek', { direction: 'forward', seconds: 10 }],
  ['video_seek', { direction: 'back', seconds: 2.5 }],
  ...each(ON_OFF, (mode) => ['video_mute', { mode }]),
  ...each(ON_OFF, (mode) => ['video_loop', { mode }]),
  ['playlist_entry', { entry: 2, target: 'preview' }],
  ['playlist_entry', { entry: 3, target: 'air' }],
  ['playlist_step', { direction: 'next' }],
  ['playlist_step', { direction: 'prev' }],
  ...each(PREVIEW_CMDS, (cmd) => ['preview', { cmd }]),
  ['preview_goto', { slide: 2 }],
  ...each(TIMER_CMDS, (cmd) => ['timer', { cmd }]),
  ['timer_set', { duration: '15' }],
  ['timer_set', { duration: '1:30' }],
  ['timer_adjust', { direction: 'add', amount: '1' }],
  ['timer_adjust', { direction: 'sub', amount: '30s' }],
  ['timer_preset', { preset: 2 }],
  ...each(TIMER_MODES, (mode) => ['timer_mode', { mode }]),
  ...each(TIMER_POSITIONS, (position) => ['timer_position', { position }]),
  ['message_preset', { preset: 1 }],
  ['message_text', { text: 'Вопросы / ответы из зала?' }],
  ['message_clear', {}],
  ['custom', { path: 'timer/set/20' }],
]

describe('модуль Companion → команды CueDeck', () => {
  it.each(ALL)('%s %j', (actionId, options) => {
    const c = commandFor(actionId, options)
    expect(c).not.toBeNull()
    const r = viaHttp(commandUrl(c!))
    expect(r.ok ? true : r.error).toBe(true)
  })

  it('текст сообщения доходит целиком — со слэшем, кириллицей и знаком вопроса', () => {
    const r = viaHttp(commandUrl(commandFor('message_text', { text: 'Вопросы / ответы из зала?' })!))
    expect(r.ok && r.calls[0].args[0]).toBe('Вопросы / ответы из зала?')
  })

  it('custom принимает вставленный целиком URL из «Списка команд»', () => {
    expect(commandFor('custom', { path: 'http://127.0.0.1:9420/api/timer/set/20' })).toEqual({ path: 'timer/set/20' })
    expect(commandFor('custom', { path: '/api/message/text?value=%D0%92%D1%80%D0%B5%D0%BC%D1%8F' })).toEqual({
      path: 'message/text',
      value: 'Время',
    })
    const r = viaHttp(commandUrl(commandFor('custom', { path: '/api/message/text/%D0%92%D1%80%D0%B5%D0%BC%D1%8F' })!))
    expect(r.ok && r.calls[0].args[0]).toBe('Время')
  })

  it('пустой ввод ничего не отправляет', () => {
    expect(commandFor('timer_set', { duration: '  ' })).toBeNull()
    expect(commandFor('message_text', { text: '' })).toBeNull()
    expect(commandFor('custom', { path: '' })).toBeNull()
    expect(commandFor('нет такого', {})).toBeNull()
  })
})

describe('модуль Companion: /api/state → переменные', () => {
  const s: CueDeckState = {
    ok: true,
    app: 'CueDeck',
    version: '0.7.1',
    timer: {
      text: '−00:12',
      color: 'red',
      overtime: true,
      running: true,
      mode: 'countdown',
      position: 'top-right',
      durationMs: 600_000,
      durationText: '10:00',
      elapsedMs: 612_000,
      remainingMs: -12_400,
    },
    program: { name: 'Иванов.pdf', kind: 'pdf', slide: 3, total: 12, remaining: 9, text: '3/12', blackout: false, playlistIndex: 1 },
    video: { active: false, playing: false, muted: true, loop: false, positionSec: 0, durationSec: 0, remainingText: '00:40' },
    preview: { name: 'Петров.pptx', kind: 'pptx', slide: 1, total: 20, playlistIndex: 2 },
    playlist: { count: 3, names: ['Иванов.pdf', 'Петров.pptx', 'Ролик.mp4'] },
    next: { name: 'Ролик.mp4', playlistIndex: 3 },
    speakerMessage: null,
    timerPresets: [5, 10, 15, 20],
    messagePresets: ['Заканчивайте', 'Ближе к микрофону', '', '', '', ''],
  }

  it('значения', () => {
    const v = variableValues(s)
    expect(v).toMatchObject({
      connected: true,
      timer: '−00:12',
      timer_over: true,
      timer_remaining_s: -12,
      slide: '3/12',
      slides_left: 9,
      program: 'Иванов',
      preview: 'Петров',
      next: 'Ролик',
      next_index: 3,
      video_remaining: '', // ролика в эфире нет — остаток не показываем
      muted: true,
      message: '',
      speaker_1: 'Иванов',
      speaker_3: 'Ролик',
      speaker_8: '',
      timer_preset_2: 10,
      message_preset_6: '',
      // Объект s без поля stream — как /api/state у CueDeck до 0.8.1 (PLAN 2.21): не ломается, просто пусто.
      stream_running: false,
      stream_warn: false,
      stream_live: '',
      stream_total: '',
    })
  })

  it('трансляция: идёт, площадка не в порядке', () => {
    const v = variableValues({ ...s, stream: { running: true, live: 1, total: 2, warn: true } })
    expect(v).toMatchObject({ stream_running: true, stream_warn: true, stream_live: 1, stream_total: 2 })
  })

  it('трансляция выключена — предупреждение не горит, даже если warn пришёл true', () => {
    const v = variableValues({ ...s, stream: { running: false, live: 0, total: 2, warn: true } })
    expect(v).toMatchObject({ stream_running: false, stream_warn: false })
  })

  it('у каждого значения есть определение, и наоборот', () => {
    expect(Object.keys(variableValues(s)).sort()).toEqual(Object.keys(variableNames(s)).sort())
    expect(Object.keys(variableValues(null)).sort()).toEqual(Object.keys(variableNames(null)).sort())
  })

  it('нет связи — всё пусто, флаги выключены', () => {
    const v = variableValues(null)
    expect(v.connected).toBe(false)
    expect(v.timer).toBe('')
    expect(v.timer_over).toBe(false)
    expect(v.speaker_1).toBe('')
  })

  it('CueDeck 0.7.0 (без имён и пресетов в /api/state) не ломает модуль', () => {
    const old = { ...s, playlist: { count: 3 }, next: undefined, timerPresets: undefined, messagePresets: undefined }
    const v = variableValues(old)
    expect(v.speaker_1).toBe('')
    expect(v.next).toBe('')
    expect(v.timer).toBe('−00:12')
  })
})
