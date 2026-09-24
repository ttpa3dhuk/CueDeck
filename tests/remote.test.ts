import { describe, expect, it } from 'vitest'
import { encodeOscBundle, encodeOscMessage, parseOscPacket } from '../src/main/remote/osc'
import { parseDurationMs, resolveRemote, type RemoteStateView } from '../src/main/remote/commands'
import { COMPANION_VARS, companionVars, diffVars, type CompanionStateView } from '../src/main/remote/companion-vars'

const video = { playing: false, anchorSec: 0, anchorAt: null, durationSec: 0, muted: false }
const emptyDeck = {
  path: null,
  sha1: null,
  kind: null,
  totalSlides: 0,
  currentSlide: 0,
  notes: {},
  playlistId: null,
  slideMedia: [],
  video,
} as unknown as RemoteStateView['preview']
const entry = (id: string, kind = 'pdf') =>
  ({ id, kind, filePath: `/x/${id}`, fileName: id, durationMs: 0 }) as unknown as RemoteStateView['playlist'][number]

const state = (over: Partial<RemoteStateView> = {}): RemoteStateView => ({
  timer: { durationMs: 600_000, startedAt: null, elapsedMs: 0, running: false, cycles: 0 },
  timerPosition: 'top-right',
  timerPresets: [5, 10, 15, 20],
  speakerMsgPresets: ['Заканчивайте', 'Ближе к микрофону', '', '', '', ''],
  fileKind: null,
  pdfPath: null,
  slideMedia: [],
  currentSlide: 0,
  blackout: false,
  video,
  videoLoop: false,
  playlist: [],
  currentPlaylistId: null,
  preview: emptyDeck,
  ...over,
})
const channels = (r: ReturnType<typeof resolveRemote>) => (r.ok ? r.calls.map((c) => c.channel) : r.error)

const seg = (p: string): string[] => p.split('/').filter(Boolean)

describe('OSC', () => {
  it('сообщение без аргументов', () => {
    expect(parseOscPacket(encodeOscMessage('/cuedeck/timer/start'))).toEqual([
      { address: '/cuedeck/timer/start', args: [] },
    ])
  })

  it('аргументы i f s T F N', () => {
    const [m] = parseOscPacket(encodeOscMessage('/x', [5, 1.5, 'Вопросы', true, false, null]))
    expect(m.address).toBe('/x')
    expect(m.args).toEqual([5, 1.5, 'Вопросы', true, false, null])
  })

  it('бандл раскрывается в список сообщений', () => {
    const b = encodeOscBundle([encodeOscMessage('/a', [1]), encodeOscMessage('/b', ['x'])])
    expect(parseOscPacket(b).map((m) => m.address)).toEqual(['/a', '/b'])
  })

  it('адрес без тегов типов (старые отправители)', () => {
    const buf = Buffer.from('/cuedeck/timer/reset\0\0\0\0', 'ascii')
    expect(parseOscPacket(buf)).toEqual([{ address: '/cuedeck/timer/reset', args: [] }])
  })

  it('мусор — исключение, а не падение процесса', () => {
    expect(() => parseOscPacket(Buffer.from('hello'))).toThrow()
  })
})

describe('parseDurationMs', () => {
  it.each([
    ['15', 900_000],
    ['0.5', 30_000],
    ['1:30', 90_000],
    ['1:00:00', 3_600_000],
    ['90s', 90_000],
    ['5m', 300_000],
    ['2мин', 120_000],
    ['1h', 3_600_000],
    [10, 600_000],
  ])('%s → %i мс', (v, ms) => {
    expect(parseDurationMs(v)).toBe(ms)
  })

  it('минус только там, где разрешён', () => {
    expect(parseDurationMs('-1')).toBeNull()
    expect(parseDurationMs('-1', true)).toBe(-60_000)
    expect(parseDurationMs('−0:30', true)).toBe(-30_000)
  })

  it('мусор и перебор → null', () => {
    expect(parseDurationMs('abc')).toBeNull()
    expect(parseDurationMs('')).toBeNull()
    expect(parseDurationMs('999h')).toBeNull()
    expect(parseDurationMs(Number.NaN)).toBeNull()
  })
})

describe('resolveRemote', () => {
  it('простая команда → свой ipc-канал', () => {
    expect(resolveRemote(seg('timer/start'), [], state())).toEqual({
      ok: true,
      command: 'timer/start',
      calls: [{ channel: 'timer:start', args: [] }],
    })
  })

  it('регистр в пути не важен, алиасы работают', () => {
    const r = resolveRemote(seg('Timer/STOP'), [], state())
    expect(r.ok && r.calls).toEqual([{ channel: 'timer:pause', args: [] }])
  })

  it('toggle смотрит на состояние', () => {
    const idle = resolveRemote(seg('timer/toggle'), [], state())
    const run = resolveRemote(
      seg('timer/toggle'),
      [],
      state({ timer: { durationMs: 1, startedAt: 1, elapsedMs: 0, running: true, cycles: 0 } }),
    )
    expect(idle.ok && idle.calls[0].channel).toBe('timer:start')
    expect(run.ok && run.calls[0].channel).toBe('timer:pause')
  })

  it('restart = сброс + старт', () => {
    const r = resolveRemote(seg('timer/restart'), [], state())
    expect(r.ok && r.calls.map((c) => c.channel)).toEqual(['timer:reset', 'timer:start'])
  })

  it('аргумент из хвоста пути и из OSC — одно и то же', () => {
    const a = resolveRemote(seg('timer/add/5'), [], state())
    const b = resolveRemote(seg('timer/add'), [5], state())
    expect(a).toEqual(b)
    expect(a.ok && a.calls).toEqual([{ channel: 'timer:adjust', args: [300_000] }])
  })

  it('sub убавляет', () => {
    const r = resolveRemote(seg('timer/sub/0:30'), [], state())
    expect(r.ok && r.calls).toEqual([{ channel: 'timer:adjust', args: [-30_000] }])
  })

  it('пресет берётся из текущих настроек оператора', () => {
    const r = resolveRemote(seg('timer/preset/2'), [], state({ timerPresets: [3, 7, 11, 13] }))
    expect(r.ok && r.calls).toEqual([{ channel: 'timer:set-duration', args: [420_000] }])
    expect(resolveRemote(seg('timer/preset/9'), [], state()).ok).toBe(false)
    expect(resolveRemote(seg('timer/preset/0'), [], state()).ok).toBe(false)
  })

  it('режим и положение — только из списка', () => {
    expect(resolveRemote(seg('timer/mode/clock'), [], state()).ok).toBe(true)
    expect(resolveRemote(seg('timer/mode/rocket'), [], state()).ok).toBe(false)
    expect(resolveRemote(seg('timer/position/hidden'), [], state()).ok).toBe(true)
    expect(resolveRemote(seg('timer/position/center'), [], state()).ok).toBe(false)
  })

  it('full перещёлкивает как кнопка ⛶', () => {
    const a = resolveRemote(seg('timer/full'), [], state({ timerPosition: 'top-left' }))
    const b = resolveRemote(seg('timer/full'), [], state({ timerPosition: 'full' }))
    const c = resolveRemote(seg('timer/full'), [], state({ timerPosition: 'full-noflash' }))
    expect(a.ok && a.calls[0].args).toEqual(['full'])
    expect(b.ok && b.calls[0].args).toEqual(['full-noflash'])
    expect(c.ok && c.calls[0].args).toEqual(['full'])
  })

  it('отпускание кнопки (0/false) у команды без аргумента игнорируется', () => {
    const r = resolveRemote(seg('timer/toggle'), [0], state())
    expect(r).toMatchObject({ ok: true, calls: [], ignored: true })
    const press = resolveRemote(seg('timer/toggle'), [1], state())
    expect(press.ok && press.calls.length).toBe(1)
  })

  it('сообщение спикеру: пресет, текст (регистр и слэши сохраняются), сброс', () => {
    const p = resolveRemote(seg('message/preset/1'), [], state())
    expect(p.ok && p.calls).toEqual([{ channel: 'speaker-message:set', args: ['Заканчивайте'] }])
    expect(resolveRemote(seg('message/preset/3'), [], state()).ok).toBe(false) // пустой слот
    const t = resolveRemote(['message', 'text', 'Осталось', '5/10'], [], state())
    expect(t.ok && t.calls[0].args).toEqual(['Осталось/5/10'])
    const osc = resolveRemote(seg('message/text'), ['Вопросы из зала'], state())
    expect(osc.ok && osc.calls[0].args).toEqual(['Вопросы из зала'])
    const c = resolveRemote(seg('message/clear'), [], state())
    expect(c.ok && c.calls[0].args).toEqual([null])
  })

  it('неизвестное, пустое, лишний хвост, нет аргумента — ошибка с текстом', () => {
    for (const p of ['', 'nav/next', 'timer/start/now', 'timer/set', 'timer/set/abc', 'blackout/maybe']) {
      const r = resolveRemote(seg(p), [], state())
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error.length).toBeGreaterThan(0)
    }
  })
})

describe('resolveRemote — эфир (сразу в эфир, решение 2026-09-24)', () => {
  it('далее/назад — те же каналы, что у кликера; короткие алиасы', () => {
    expect(channels(resolveRemote(seg('program/next'), [], state()))).toEqual(['nav:next'])
    expect(channels(resolveRemote(seg('next'), [], state()))).toEqual(['nav:next'])
    expect(channels(resolveRemote(seg('prev'), [], state()))).toEqual(['nav:prev'])
    const g = resolveRemote(seg('program/goto/7'), [], state())
    expect(g.ok && g.calls).toEqual([{ channel: 'nav:goto', args: [7] }])
  })

  it('ЭФИР — только если в превью что-то есть', () => {
    expect(resolveRemote(seg('take'), [], state()).ok).toBe(false)
    const withPreview = state({ preview: { ...emptyDeck, path: '/x/a.pdf' } })
    expect(channels(resolveRemote(seg('take'), [], withPreview))).toEqual(['preview:take'])
  })

  it('blackout: toggle всегда, on/off — только если нужно менять', () => {
    expect(channels(resolveRemote(seg('blackout'), [], state()))).toEqual(['blackout:toggle'])
    expect(channels(resolveRemote(seg('blackout/on'), [], state()))).toEqual(['blackout:toggle'])
    expect(channels(resolveRemote(seg('blackout/on'), [], state({ blackout: true })))).toEqual([])
    expect(channels(resolveRemote(seg('blackout/off'), [], state()))).toEqual([])
    expect(channels(resolveRemote(seg('blackout/off'), [], state({ blackout: true })))).toEqual(['blackout:toggle'])
  })

  it('видео: без ролика в эфире — внятная ошибка, а не тихий «успех»', () => {
    for (const p of ['video/play', 'video/toggle', 'video/restart', 'video/forward/10']) {
      const r = resolveRemote(seg(p), [], state({ fileKind: 'pdf' }))
      expect(r.ok).toBe(false)
    }
  })

  it('видео: файл-ролик и PPTX-слайд с видео считаются роликом', () => {
    const vid = state({ fileKind: 'video' })
    expect(channels(resolveRemote(seg('video/toggle'), [], vid))).toEqual(['video:toggle'])
    expect(channels(resolveRemote(seg('video/restart'), [], vid))).toEqual(['video:seek', 'video:play'])
    expect(channels(resolveRemote(seg('video/stop'), [], vid))).toEqual(['video:pause', 'video:seek'])
    const back = resolveRemote(seg('video/back/10'), [], vid)
    expect(back.ok && back.calls).toEqual([{ channel: 'video:seek-by', args: [-10] }])
    const pptx = state({
      fileKind: 'pptx',
      currentSlide: 3,
      slideMedia: [{ slide: 3, rect: { x: 0, y: 0, w: 1, h: 1 }, file: 'a.mp4' }] as RemoteStateView['slideMedia'],
    })
    expect(resolveRemote(seg('video/play'), [], pptx).ok).toBe(true)
    expect(resolveRemote(seg('video/play'), [], { ...pptx, currentSlide: 4 }).ok).toBe(false)
  })

  it('звук эфира: set-muted с нужным значением; работает и без ролика', () => {
    const r = resolveRemote(seg('video/mute'), [], state())
    expect(r.ok && r.calls).toEqual([{ channel: 'video:set-muted', args: [true] }])
    expect(channels(resolveRemote(seg('video/mute/on'), [], state({ video: { ...video, muted: true } })))).toEqual([])
  })

  it('цикл — только у ролика в эфире', () => {
    expect(resolveRemote(seg('video/loop'), [], state({ fileKind: 'pdf' })).ok).toBe(false)
    const r = resolveRemote(seg('video/loop/on'), [], state({ fileKind: 'video' }))
    expect(r.ok && r.calls).toEqual([{ channel: 'video:set-loop', args: [true] }])
  })

  it('плейлист: номер карточки → id записи; в превью или сразу в эфир', () => {
    const pl = state({ playlist: [entry('a'), entry('b'), entry('c')] })
    const sel = resolveRemote(seg('playlist/select/2'), [], pl)
    expect(sel.ok && sel.calls).toEqual([{ channel: 'playlist:activate', args: ['b'] }])
    const air = resolveRemote(seg('playlist/air/3'), [], pl)
    expect(air.ok && air.calls).toEqual([{ channel: 'playlist:activate-live', args: ['c'] }])
    expect(resolveRemote(seg('playlist/select/4'), [], pl).ok).toBe(false)
    expect(resolveRemote(seg('playlist/select/1'), [], state()).ok).toBe(false)
  })

  it('плейлист next/prev: от дальней из эфир/превью, эфир перешагивается', () => {
    const base = { playlist: [entry('a'), entry('b'), entry('c')] }
    const arg = (r: ReturnType<typeof resolveRemote>) => (r.ok ? r.calls[0]?.args[0] : r.error)
    expect(arg(resolveRemote(seg('playlist/next'), [], state(base)))).toBe('a')
    expect(arg(resolveRemote(seg('playlist/prev'), [], state(base)))).toBe('c')
    expect(arg(resolveRemote(seg('playlist/next'), [], state({ ...base, currentPlaylistId: 'a' })))).toBe('b')
    const inPreview = state({ ...base, currentPlaylistId: 'a', preview: { ...emptyDeck, playlistId: 'b' } })
    expect(arg(resolveRemote(seg('playlist/next'), [], inPreview))).toBe('c')
    expect(resolveRemote(seg('playlist/next'), [], state({ ...base, currentPlaylistId: 'c' })).ok).toBe(false)
    // После ЭФИРа прежний спикер (a) уехал в превью, в эфире b → следующий c, а не снова b.
    const swapped = state({ ...base, currentPlaylistId: 'b', preview: { ...emptyDeck, playlistId: 'a' } })
    expect(arg(resolveRemote(seg('playlist/next'), [], swapped))).toBe('c')
    // Назад из превью c при эфире b → a (b в эфире перешагиваем).
    const back = state({ ...base, currentPlaylistId: 'b', preview: { ...emptyDeck, playlistId: 'c' } })
    expect(arg(resolveRemote(seg('playlist/prev'), [], back))).toBe('a')
  })

  it('превью: листание и ролик', () => {
    expect(channels(resolveRemote(seg('preview/next'), [], state()))).toEqual(['preview:next'])
    expect(resolveRemote(seg('preview/video/toggle'), [], state()).ok).toBe(false)
    const pv = state({ preview: { ...emptyDeck, kind: 'video' } })
    expect(channels(resolveRemote(seg('preview/video/toggle'), [], pv))).toEqual(['preview:video:toggle'])
  })
})

describe('companionVars — что уходит на кнопки Companion', () => {
  const cstate = (over: Partial<CompanionStateView> = {}): CompanionStateView => ({
    ...state(),
    timerMode: 'countdown',
    totalSlides: 0,
    speakerMessage: null,
    ...over,
  })

  it('таймер: текст, цвет, «вышло», идёт ли', () => {
    const now = 1_000_000
    const over = companionVars(
      cstate({ timer: { durationMs: 60_000, startedAt: now - 72_000, elapsedMs: 0, running: true, cycles: 0 } }),
      now,
      0,
    )
    expect(over.cuedeck_timer).toBe('−00:12')
    expect(over.cuedeck_timer_color).toBe('red')
    expect(over.cuedeck_timer_over).toBe('1')
    expect(over.cuedeck_timer_running).toBe('1')
    const idle = companionVars(cstate(), now, 0)
    expect(idle.cuedeck_timer).toBe('10:00')
    expect(idle.cuedeck_timer_over).toBe('0')
  })

  it('слайды и остаток; у ролика слайдов нет, зато есть остаток времени', () => {
    const pdf = companionVars(cstate({ fileKind: 'pdf', pdfPath: '/x/a.pdf', totalSlides: 12, currentSlide: 3 }), 0, 0)
    expect([pdf.cuedeck_slide, pdf.cuedeck_slides_left, pdf.cuedeck_video]).toEqual(['3/12', '9', ''])
    const vid = companionVars(
      cstate({ fileKind: 'video', pdfPath: '/x/r.mp4', totalSlides: 1, currentSlide: 1, video: { ...video, durationSec: 21, playing: true } }),
      0,
      8,
    )
    expect([vid.cuedeck_slide, vid.cuedeck_video, vid.cuedeck_video_playing]).toEqual(['', '00:13', '1'])
  })

  it('имена: эфир, превью, следующий спикер — без расширений', () => {
    const e = (id: string, name: string) =>
      ({ ...entry(id), fileName: name, displayName: '' }) as RemoteStateView['playlist'][number]
    const v = companionVars(
      cstate({
        playlist: [e('a', 'Иванов.pdf'), e('b', 'Петров.pptx'), e('c', 'Ролик.mp4')],
        currentPlaylistId: 'a',
        pdfPath: '/x/Иванов.pdf',
        preview: { ...emptyDeck, path: '/x/Петров.pptx', playlistId: 'b' },
      }),
      0,
      0,
    )
    expect([v.cuedeck_program, v.cuedeck_preview, v.cuedeck_next]).toEqual(['Иванов', 'Петров', 'Ролик'])
  })

  it('отправляется только разница', () => {
    const last = new Map([['cuedeck_timer', '10:00'], ['cuedeck_blackout', '0']])
    expect(diffVars({ cuedeck_timer: '09:59', cuedeck_blackout: '0' }, last)).toEqual([['cuedeck_timer', '09:59']])
  })

  it('имена переменных годятся для Companion (буквы, цифры, _)', () => {
    for (const k of Object.keys(COMPANION_VARS)) expect(k).toMatch(/^[a-z0-9_]+$/)
    expect(Object.keys(companionVars(cstate(), 0, 0)).sort()).toEqual(Object.keys(COMPANION_VARS).sort())
  })
})
