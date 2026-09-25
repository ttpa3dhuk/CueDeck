import type { AppState, TimerMode, TimerPosition } from '../../shared/types.js'
import { t } from '../../shared/i18n.js'

/**
 * Таблица команд внешнего управления (PLAN 2.18) — без Electron, покрыта
 * тестами. Одна таблица на все входы: HTTP-путь `/api/timer/add/5` и
 * OSC-адрес `/cuedeck/timer/add 5` приходят сюда одинаковым списком сегментов.
 *
 * Команда не исполняет ничего сама — она переводится в вызовы тех же
 * ipc-каналов, что дёргают кнопки оператора (`timer:start`, …). Второго пути
 * исполнения нет: логика таймера живёт только в ipc.ts.
 *
 * Команды эфира исполняются **сразу в эфир** — решение Азата 2026-09-24:
 * Stream Deck — пульт оператора, как кликер, а не чужая система. «Далее» идёт
 * через тот же programNext, что и кликер: на слайде/ролике с видео первый
 * «далее» запускает ролик.
 */

export type RemoteArg = string | number | boolean | null

export interface IpcCall {
  channel: string
  args: unknown[]
}

export type RemoteStateView = Pick<
  AppState,
  | 'timer'
  | 'timerPosition'
  | 'timerPresets'
  | 'speakerMsgPresets'
  | 'fileKind'
  | 'pdfPath'
  | 'slideMedia'
  | 'currentSlide'
  | 'blackout'
  | 'video'
  | 'videoLoop'
  | 'playlist'
  | 'currentPlaylistId'
  | 'preview'
>

type ArgKind = 'none' | 'duration' | 'index' | 'number' | 'seconds' | 'enum' | 'text'

type Group =
  | 'Эфир'
  | 'Видео в эфире'
  | 'Плейлист'
  | 'Превью'
  | 'Таймер'
  | 'Сообщение спикеру'

export interface RemoteCommand {
  /** Путь без префикса: `timer/start`. */
  path: string
  aliases?: string[]
  arg: ArgKind
  values?: readonly string[]
  group: Group
  /** Русское название — ключ словаря; на экран — через commandTitle(). */
  title: string
  /** У вкл/выкл-команд — чем управляют («Заставка / blackout»), title тогда — действие. */
  what?: string
  /** Пример аргумента для справочной страницы. */
  example?: string
  build(arg: RemoteArg, s: RemoteStateView): IpcCall[] | string
}

export const TIMER_MODES = ['countdown', 'stopwatch', 'clock'] as const satisfies readonly TimerMode[]
export const TIMER_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'hidden',
  'full',
  'full-noflash',
  'free',
] as const satisfies readonly TimerPosition[]

const MAX_DURATION_MS = 100 * 3600_000

const call = (channel: string, ...args: unknown[]): IpcCall => ({ channel, args })

/**
 * Длительность → мс. Голое число — минуты (так удобнее на кнопке: `add/5`);
 * `1:30` — мин:сек, `1:00:00` — ч:мм:сс; суффиксы `90s`, `5m`, `1h`
 * (и русские с/м/ч). Минус разрешён только там, где он имеет смысл (`signed`).
 */
export function parseDurationMs(v: RemoteArg, signed = false): number | null {
  let ms: number | null = null
  if (typeof v === 'number') {
    ms = Number.isFinite(v) ? v * 60_000 : null
  } else if (typeof v === 'string') {
    const raw = v.trim().toLowerCase().replace(',', '.').replace('−', '-')
    const m = /^([+-]?)(.*)$/.exec(raw)!
    const sign = m[1] === '-' ? -1 : 1
    const body = m[2]
    let abs: number | null = null
    let r: RegExpExecArray | null
    if (/^\d+(\.\d+)?$/.test(body)) {
      abs = Number(body) * 60_000
    } else if ((r = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(body))) {
      abs =
        r[3] !== undefined
          ? (Number(r[1]) * 3600 + Number(r[2]) * 60 + Number(r[3])) * 1000
          : (Number(r[1]) * 60 + Number(r[2])) * 1000
    } else if ((r = /^(\d+(?:\.\d+)?)\s*(s|sec|с|сек|m|min|м|мин|h|ч)$/.exec(body))) {
      const unit = r[2]
      const k = /^(s|sec|с|сек)$/.test(unit) ? 1000 : /^(h|ч)$/.test(unit) ? 3600_000 : 60_000
      abs = Number(r[1]) * k
    }
    if (abs !== null) ms = sign * abs
  }
  if (ms === null || !Number.isFinite(ms)) return null
  ms = Math.round(ms)
  if (!signed && ms < 0) return null
  if (Math.abs(ms) > MAX_DURATION_MS) return null
  return ms
}

/** Номер с единицы (так он подписан на кнопке): `preset/2` → индекс 1. */
function parseIndex(v: RemoteArg): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
  if (!Number.isInteger(n) || n < 1) return null
  return n - 1
}

/** Целое ≥ 1 как есть (номер слайда). */
function parsePositive(v: RemoteArg): number | null {
  const i = parseIndex(v)
  return i === null ? null : i + 1
}

/** Секунды перемотки: `10`, `2.5`, `1:30`. */
function parseSeconds(v: RemoteArg): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim().replace(',', '.')
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) > 0 ? Number(t) : null
  const m = /^(\d+):(\d{1,2})$/.exec(t)
  return m ? Number(m[1]) * 60 + Number(m[2]) || null : null
}

/** В эфире есть что играть: файл-ролик или PPTX-слайд с видео. */
export function programHasVideo(s: RemoteStateView): boolean {
  if (s.fileKind === 'video') return true
  return s.fileKind === 'pptx' && s.slideMedia.some((m) => m.slide === s.currentSlide)
}

const withVideo =
  (build: (s: RemoteStateView) => IpcCall[]) =>
  (_a: RemoteArg, s: RemoteStateView): IpcCall[] | string =>
    programHasVideo(s) ? build(s) : t('в эфире нет ролика')

/** Запись плейлиста по номеру карточки (с единицы, как подписано у оператора). */
function entryAt(a: RemoteArg, s: RemoteStateView): { id: string } | string {
  const i = parseIndex(a)
  if (i === null) return t('нужен номер записи с единицы')
  const e = s.playlist[i]
  if (!e) return s.playlist.length ? t('в плейлисте {n} записей', { n: s.playlist.length }) : t('плейлист пуст')
  return e
}

/**
 * Соседняя запись для превью. Вперёд — от дальней из двух (эфир / превью):
 * после ЭФИРа прежний спикер уезжает в превью (обмен деками), и считать от
 * превью значило бы снова выбрать того, кто уже в эфире. Назад — от превью
 * (или эфира), перешагивая запись в эфире. Ничего не выбрано — край списка.
 */
export function neighbour(s: RemoteStateView, dir: 1 | -1): { id: string } | string {
  const n = s.playlist.length
  if (!n) return t('плейлист пуст')
  const at = (id: string | null): number => (id ? s.playlist.findIndex((e) => e.id === id) : -1)
  const prog = at(s.currentPlaylistId)
  const prev = at(s.preview.playlistId)
  let i: number
  if (dir === 1) {
    const base = Math.max(prog, prev)
    i = base + 1
  } else {
    const base = prev >= 0 ? prev : prog
    i = base < 0 ? n - 1 : base - 1
    if (i === prog && prog >= 0) i -= 1
  }
  const e = s.playlist[i]
  return e ?? (dir === 1 ? t('это последняя запись') : t('это первая запись'))
}

const onOff = (
  base: string,
  group: Group,
  what: string,
  channelFor: (want: boolean, s: RemoteStateView) => IpcCall[] | string,
  current: (s: RemoteStateView) => boolean,
): RemoteCommand[] => [
  {
    path: `${base}/toggle`,
    aliases: [base],
    arg: 'none',
    group,
    what,
    title: 'переключить',
    build: (_a, s) => channelFor(!current(s), s),
  },
  {
    path: `${base}/on`,
    arg: 'none',
    group,
    what,
    title: 'включить',
    build: (_a, s) => (current(s) ? [] : channelFor(true, s)),
  },
  {
    path: `${base}/off`,
    arg: 'none',
    group,
    what,
    title: 'выключить',
    build: (_a, s) => (current(s) ? channelFor(false, s) : []),
  },
]

export const REMOTE_COMMANDS: RemoteCommand[] = [
  // ── Эфир ──
  {
    path: 'program/next',
    aliases: ['next'],
    arg: 'none',
    group: 'Эфир',
    title: 'Далее — как кликер (на слайде с роликом первый «далее» запускает ролик)',
    build: () => [call('nav:next')],
  },
  {
    path: 'program/prev',
    aliases: ['prev'],
    arg: 'none',
    group: 'Эфир',
    title: 'Назад',
    build: () => [call('nav:prev')],
  },
  {
    path: 'program/goto',
    arg: 'number',
    group: 'Эфир',
    title: 'Перейти к слайду',
    example: '1',
    build: (a) => {
      const n = parsePositive(a)
      return n === null ? t('нужен номер слайда') : [call('nav:goto', n)]
    },
  },
  {
    path: 'take',
    aliases: ['program/take', 'preview/take'],
    arg: 'none',
    group: 'Эфир',
    title: 'ЭФИР — выдать превью в зал',
    build: (_a, s) => (s.preview.path ? [call('preview:take')] : t('превью пустое — выдавать нечего')),
  },
  ...onOff('blackout', 'Эфир', 'Заставка / blackout', () => [call('blackout:toggle')], (s) => s.blackout),

  // ── Видео в эфире ──
  {
    path: 'video/play',
    arg: 'none',
    group: 'Видео в эфире',
    title: 'Пуск',
    build: withVideo(() => [call('video:play')]),
  },
  {
    path: 'video/pause',
    arg: 'none',
    group: 'Видео в эфире',
    title: 'Пауза',
    build: withVideo(() => [call('video:pause')]),
  },
  {
    path: 'video/toggle',
    arg: 'none',
    group: 'Видео в эфире',
    title: 'Пуск / пауза (одна кнопка)',
    build: withVideo(() => [call('video:toggle')]),
  },
  {
    path: 'video/restart',
    arg: 'none',
    group: 'Видео в эфире',
    title: 'С начала и пуск',
    build: withVideo(() => [call('video:seek', 0), call('video:play')]),
  },
  {
    path: 'video/stop',
    arg: 'none',
    group: 'Видео в эфире',
    title: 'Стоп — пауза на первом кадре',
    build: withVideo(() => [call('video:pause'), call('video:seek', 0)]),
  },
  {
    path: 'video/forward',
    arg: 'seconds',
    group: 'Видео в эфире',
    title: 'Вперёд на N секунд',
    example: '10',
    build: (a, s) => {
      const sec = parseSeconds(a)
      if (sec === null) return t('нужны секунды: 10, 2.5, 1:30')
      return programHasVideo(s) ? [call('video:seek-by', sec)] : t('в эфире нет ролика')
    },
  },
  {
    path: 'video/back',
    arg: 'seconds',
    group: 'Видео в эфире',
    title: 'Назад на N секунд',
    example: '10',
    build: (a, s) => {
      const sec = parseSeconds(a)
      if (sec === null) return t('нужны секунды: 10, 2.5, 1:30')
      return programHasVideo(s) ? [call('video:seek-by', -sec)] : t('в эфире нет ролика')
    },
  },
  ...onOff('video/mute', 'Видео в эфире', 'Звук эфира выкл', (want) => [call('video:set-muted', want)], (s) => s.video.muted),
  ...onOff(
    'video/loop',
    'Видео в эфире',
    'Цикл ролика',
    (want, s) => (s.fileKind === 'video' ? [call('video:set-loop', want)] : t('цикл есть только у ролика в эфире')),
    (s) => s.videoLoop,
  ),

  // ── Плейлист ──
  {
    path: 'playlist/select',
    arg: 'index',
    group: 'Плейлист',
    title: 'Запись N — в превью (номер на карточке)',
    example: '1',
    build: (a, s) => {
      const e = entryAt(a, s)
      return typeof e === 'string' ? e : [call('playlist:activate', e.id)]
    },
  },
  {
    path: 'playlist/air',
    arg: 'index',
    group: 'Плейлист',
    title: 'Запись N — сразу в эфир, минуя превью',
    example: '1',
    build: (a, s) => {
      const e = entryAt(a, s)
      return typeof e === 'string' ? e : [call('playlist:activate-live', e.id)]
    },
  },
  {
    path: 'playlist/next',
    arg: 'none',
    group: 'Плейлист',
    title: 'Следующая запись — в превью (от той, что в превью, иначе от эфира)',
    build: (_a, s) => {
      const e = neighbour(s, 1)
      return typeof e === 'string' ? e : [call('playlist:activate', e.id)]
    },
  },
  {
    path: 'playlist/prev',
    arg: 'none',
    group: 'Плейлист',
    title: 'Предыдущая запись — в превью',
    build: (_a, s) => {
      const e = neighbour(s, -1)
      return typeof e === 'string' ? e : [call('playlist:activate', e.id)]
    },
  },

  // ── Превью ──
  {
    path: 'preview/next',
    arg: 'none',
    group: 'Превью',
    title: 'Превью: следующий слайд',
    build: () => [call('preview:next')],
  },
  {
    path: 'preview/prev',
    arg: 'none',
    group: 'Превью',
    title: 'Превью: предыдущий слайд',
    build: () => [call('preview:prev')],
  },
  {
    path: 'preview/goto',
    arg: 'number',
    group: 'Превью',
    title: 'Превью: к слайду',
    example: '1',
    build: (a) => {
      const n = parsePositive(a)
      return n === null ? t('нужен номер слайда') : [call('preview:goto', n)]
    },
  },
  {
    path: 'preview/video/toggle',
    arg: 'none',
    group: 'Превью',
    title: 'Превью: ролик пуск / пауза',
    build: (_a, s) => (s.preview.kind === 'video' ? [call('preview:video:toggle')] : t('в превью нет ролика')),
  },
  {
    path: 'preview/clear',
    arg: 'none',
    group: 'Превью',
    title: 'Очистить превью',
    build: () => [call('preview:clear')],
  },

  // ── Таймер ──
  {
    path: 'timer/start',
    arg: 'none',
    group: 'Таймер',
    title: 'Старт',
    build: () => [call('timer:start')],
  },
  {
    path: 'timer/pause',
    aliases: ['timer/stop'],
    arg: 'none',
    group: 'Таймер',
    title: 'Пауза',
    build: () => [call('timer:pause')],
  },
  {
    path: 'timer/toggle',
    arg: 'none',
    group: 'Таймер',
    title: 'Старт / пауза (одна кнопка)',
    build: (_a, s) => [call(s.timer.running ? 'timer:pause' : 'timer:start')],
  },
  {
    path: 'timer/reset',
    arg: 'none',
    group: 'Таймер',
    title: 'Сброс',
    build: () => [call('timer:reset')],
  },
  {
    path: 'timer/restart',
    arg: 'none',
    group: 'Таймер',
    title: 'Сброс и сразу старт (следующий спикер)',
    build: () => [call('timer:reset'), call('timer:start')],
  },
  {
    path: 'timer/set',
    arg: 'duration',
    group: 'Таймер',
    title: 'Задать длительность',
    example: '15',
    build: (a) => {
      const ms = parseDurationMs(a)
      return ms === null ? t('нужна длительность: 15 (минуты), 1:30, 90s') : [call('timer:set-duration', ms)]
    },
  },
  {
    path: 'timer/add',
    arg: 'duration',
    group: 'Таймер',
    title: 'Добавить время',
    example: '1',
    build: (a) => {
      const ms = parseDurationMs(a, true)
      return ms === null ? t('нужна длительность: 1 (минута), 0:30, 30s') : [call('timer:adjust', ms)]
    },
  },
  {
    path: 'timer/sub',
    arg: 'duration',
    group: 'Таймер',
    title: 'Убавить время',
    example: '1',
    build: (a) => {
      const ms = parseDurationMs(a, true)
      return ms === null ? t('нужна длительность: 1 (минута), 0:30, 30s') : [call('timer:adjust', -ms)]
    },
  },
  {
    path: 'timer/preset',
    arg: 'index',
    group: 'Таймер',
    title: 'Пресет длительности (кнопки 5/10/15/20 у оператора)',
    example: '1',
    build: (a, s) => {
      const i = parseIndex(a)
      const min = i === null ? undefined : s.timerPresets[i]
      if (i === null || typeof min !== 'number') return t('нет пресета с таким номером (есть 1–{n})', { n: s.timerPresets.length })
      return [call('timer:set-duration', min * 60_000)]
    },
  },
  {
    path: 'timer/mode',
    arg: 'enum',
    values: TIMER_MODES,
    group: 'Таймер',
    title: 'Режим: обратный отсчёт / секундомер / часы',
    example: 'countdown',
    build: (a) => {
      const v = typeof a === 'string' ? a.trim().toLowerCase() : ''
      return (TIMER_MODES as readonly string[]).includes(v)
        ? [call('timer:set-mode', v)]
        : t('режим: {values}', { values: TIMER_MODES.join(' / ') })
    },
  },
  {
    path: 'timer/position',
    arg: 'enum',
    values: TIMER_POSITIONS,
    group: 'Таймер',
    title: 'Положение таймера на суфлёре',
    example: 'top-right',
    build: (a) => {
      const v = typeof a === 'string' ? a.trim().toLowerCase() : ''
      return (TIMER_POSITIONS as readonly string[]).includes(v)
        ? [call('timer:set-position', v)]
        : t('положение: {values}', { values: TIMER_POSITIONS.join(' / ') })
    },
  },
  {
    path: 'timer/full',
    arg: 'none',
    group: 'Таймер',
    title: '«Только таймер» на суфлёре — как кнопка ⛶ (со вспышкой ↔ без)',
    build: (_a, s) => [call('timer:set-position', s.timerPosition === 'full' ? 'full-noflash' : 'full')],
  },
  {
    path: 'message/preset',
    arg: 'index',
    group: 'Сообщение спикеру',
    title: 'Показать сообщение-пресет («Заканчивайте», …)',
    example: '1',
    build: (a, s) => {
      const i = parseIndex(a)
      const text = i === null ? '' : (s.speakerMsgPresets[i] ?? '').trim()
      return text ? [call('speaker-message:set', text)] : t('пресет пустой или нет такого номера')
    },
  },
  {
    path: 'message/text',
    arg: 'text',
    group: 'Сообщение спикеру',
    title: 'Показать свой текст',
    example: 'Вопросы из зала',
    build: (a) => {
      const text = typeof a === 'string' ? a.trim() : ''
      return text ? [call('speaker-message:set', text)] : t('нужен текст сообщения')
    },
  },
  {
    path: 'message/clear',
    arg: 'none',
    group: 'Сообщение спикеру',
    title: 'Убрать сообщение',
    build: () => [call('speaker-message:set', null)],
  },
]

/** Название команды на языке интерфейса (справочная страница). */
export function commandTitle(c: RemoteCommand): string {
  return c.what ? `${t(c.what)}: ${t(c.title)}` : t(c.title)
}

export type ResolveResult =
  | { ok: true; command: string; calls: IpcCall[] }
  | { ok: true; command: string; calls: []; ignored: true }
  | { ok: false; error: string }

function splitPath(p: string): string[] {
  return p.split('/').filter(Boolean)
}

const INDEX: { segs: string[]; cmd: RemoteCommand }[] = REMOTE_COMMANDS.flatMap((cmd) =>
  [cmd.path, ...(cmd.aliases ?? [])].map((p) => ({ segs: splitPath(p), cmd })),
).sort((a, b) => b.segs.length - a.segs.length)

/**
 * Сегменты пути (уже без `/api` или `/cuedeck`) + аргументы (OSC-аргументы или
 * `?value=` из HTTP) → вызовы ipc. Аргумент берётся из хвоста пути
 * (`timer/add/5`), а если хвоста нет — из первого внешнего аргумента.
 *
 * Для команд без аргумента внешний `0`/`false` означает «кнопку отпустили»
 * (TouchOSC и многие контроллеры шлют 1 на нажатие и 0 на отпускание) —
 * такое сообщение молча игнорируется, иначе toggle срабатывал бы дважды.
 */
export function resolveRemote(
  segments: string[],
  extra: RemoteArg[],
  s: RemoteStateView,
): ResolveResult {
  const lower = segments.map((x) => x.toLowerCase())
  const hit = INDEX.find(({ segs }) => segs.every((seg, i) => lower[i] === seg))
  if (!hit) return { ok: false, error: t('неизвестная команда: {cmd}', { cmd: segments.join('/') || t('(пусто)') }) }
  const { cmd, segs } = hit
  const tail = segments.slice(segs.length)

  if (cmd.arg === 'none') {
    if (tail.length) return { ok: false, error: `${cmd.path}: ${t('лишний хвост «{tail}»', { tail: tail.join('/') })}` }
    if (extra[0] === 0 || extra[0] === false) return { ok: true, command: cmd.path, calls: [], ignored: true }
    const r = cmd.build(null, s)
    return typeof r === 'string' ? { ok: false, error: `${cmd.path}: ${r}` } : { ok: true, command: cmd.path, calls: r }
  }

  let arg: RemoteArg
  if (tail.length) arg = cmd.arg === 'text' ? tail.join('/') : tail.length === 1 ? tail[0] : tail.join('/')
  else arg = extra[0] ?? null
  if (arg === null || arg === '') return { ok: false, error: `${cmd.path}: ${t('нужен аргумент')}` }
  const r = cmd.build(arg, s)
  return typeof r === 'string' ? { ok: false, error: `${cmd.path}: ${r}` } : { ok: true, command: cmd.path, calls: r }
}
