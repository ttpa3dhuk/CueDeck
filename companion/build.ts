/**
 * Сборка готовой страницы Bitfocus Companion для CueDeck:
 *   npx vite-node companion/build.ts   →   companion/CueDeck.companionconfig
 *
 * Файл импортируется в Companion (Import / Export) и приносит всё сразу:
 * страницу кнопок, подключение Generic HTTP к CueDeck и custom-переменные,
 * в которые CueDeck сам пишет состояние (src/main/remote/companion-vars.ts).
 * Формат — JSON экспорта Companion 5 (version 12), снят с живой установки
 * 5.0.6: у каждого свойства пара { value, isExpression }.
 *
 * Раскладка: ядро 5×3 (обычный Stream Deck на 15 кнопок видит левый верхний
 * угол страницы), колонки 5–7 и ряд 3 — добавка для Stream Deck XL (8×4).
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COMPANION_VARS } from '../src/main/remote/companion-vars'

const COMPANION_BUILD = '5.0.6+9750-stable-1acd2318f5'
const CONN_ID = 'cuedeckHttpConnection'
const HTTP_BASE = 'http://127.0.0.1:9420/api/'

// ── палитра (как в CueDeck) ──
const C = {
  black: '#000000',
  white: '#ffffff',
  muted: '#8b93a3',
  panel: '#1f232c',
  green: '#3fce7c',
  greenBg: '#1e7a45',
  yellow: '#f5c14c',
  amberBg: '#8a5a00',
  red: '#e0524a',
  redBg: '#b3261e',
  blinkRed: '#cc0000',
  blue: '#2f6fdb',
}

type Prop = { value: unknown; isExpression: boolean }
const v = (value: unknown): Prop => ({ value, isExpression: false })
const x = (expr: string): Prop => ({ value: expr, isExpression: true })
const hex = (h: string): number => parseInt(h.slice(1), 16)
const cv = (name: keyof typeof COMPANION_VARS): string => `$(custom:${name})`

let seq = 0
const uid = (p: string): string => `${p}${(++seq).toString(36).padStart(6, '0')}`

interface TextSpec {
  text: string | Prop
  y?: number
  h?: number
  size?: number
  color?: string | Prop
}

function textLayer(id: string, t: TextSpec) {
  const text = typeof t.text === 'string' ? v(t.text) : t.text
  const color = t.color === undefined ? v(hex(C.white)) : typeof t.color === 'string' ? v(hex(t.color)) : t.color
  return {
    id,
    name: 'Text',
    usage: 'auto',
    type: 'text',
    enabled: v(true),
    opacity: v(100),
    x: v(0),
    y: v(t.y ?? 0),
    width: v(100),
    height: v(t.h ?? 100),
    rotation: v(0),
    text,
    color,
    halign: v('center'),
    valign: v('center'),
    fontsize: v(t.size ?? 100),
    fontsizeAllowShrink: v(true),
    font: v('companion-sans'),
    outlineColor: v(4278190080),
  }
}

function boxLayer(bg: string | Prop) {
  return {
    id: 'box0',
    name: 'Background',
    usage: 'auto',
    type: 'box',
    enabled: v(true),
    opacity: v(100),
    x: v(0),
    y: v(0),
    width: v(100),
    height: v(100),
    rotation: v(0),
    color: typeof bg === 'string' ? v(hex(bg)) : bg,
    borderWidth: v(0),
    borderColor: v(0),
    borderPosition: v('inside'),
  }
}

interface ButtonSpec {
  /** Путь команды CueDeck: `timer/toggle` (см. «Список команд»). */
  cmd: string
  /** Верхняя подпись — что делает кнопка. */
  label: string
  /** Нижняя строка — живое значение (переменная/выражение); без неё подпись крупно по центру. */
  value?: string | Prop
  bg?: string | Prop
  valueColor?: string | Prop
  /**
   * Кегль подписи без значения — в Companion 5 это % от ВЫСОТЫ элемента, не
   * размер шрифта: 100 = строка во всю кнопку. По умолчанию 28 (две строки
   * по 7–8 букв); крупнее — и «Shrink to fit» рвёт слово посередине.
   */
  size?: number
  notes?: string
}

function button(b: ButtonSpec) {
  const layers: unknown[] = [
    {
      id: 'canvas',
      name: 'Canvas',
      usage: 'auto',
      type: 'canvas',
      decoration: v('default'),
      showStatusIcons: v('default'),
    },
    boxLayer(b.bg ?? C.black),
  ]
  if (b.value === undefined) {
    layers.push(textLayer('text0', { text: b.label, size: b.size ?? 28 }))
  } else {
    layers.push(textLayer('text0', { text: b.label, y: 0, h: 38, size: 60, color: C.muted }))
    layers.push(textLayer('text1', { text: b.value, y: 34, h: 66, size: 100, color: b.valueColor }))
  }
  return {
    type: 'button-layered',
    style: { layers },
    options: {
      stepProgression: 'auto',
      stepExpression: '',
      rotaryActions: false,
      canModifyStyleInApis: false,
      notes: b.notes ?? `CueDeck: ${b.cmd}`,
    },
    feedbacks: [],
    steps: {
      '0': {
        action_sets: {
          down: [
            {
              id: uid('act'),
              definitionId: 'get',
              connectionId: CONN_ID,
              options: {
                url: v(b.cmd),
                header: v(''),
                jsonResultDataVariable: { isExpression: false },
                result_stringify: v(true),
                statusCodeVariable: { isExpression: false },
              },
              upgradeIndex: 2,
              type: 'action',
            },
          ],
          up: [],
        },
        options: { runWhileHeld: [] },
      },
    },
    localVariables: [],
  }
}

// Связь есть: CueDeck не попрощался и слал данные меньше 10 с назад (упал —
// попрощаться не успел, и без этой проверки кнопка показывала бы замершее время).
// Часы Companion и CueDeck должны совпадать (обычно они синхронизированы по сети).
const online = `${cv('cuedeck_online')} == '1' && $(internal:time_unix) - ${cv('cuedeck_seen')} < 10`
const when = (cond: string, yes: string, no: string): Prop => x(`${cond} ? '${yes}' : '${no}'`)

// Таймер: цвет цифр как на суфлёре, на нуле фон мигает красным.
const timerButton = button({
  cmd: 'timer/toggle',
  label: 'ТАЙМЕР',
  value: x(`${online} ? ${cv('cuedeck_timer')} : 'нет связи'`),
  valueColor: x(
    `!(${online}) ? '${C.muted}' : ` +
      `${cv('cuedeck_timer_over')} == '1' ? '${C.white}' : ` +
      `${cv('cuedeck_timer_color')} == 'green' ? '${C.green}' : ` +
      `${cv('cuedeck_timer_color')} == 'yellow' ? '${C.yellow}' : ` +
      `${cv('cuedeck_timer_color')} == 'red' ? '${C.red}' : '${C.white}'`,
  ),
  bg: x(`${cv('cuedeck_timer_over')} == '1' && blink(500) ? '${C.blinkRed}' : '${C.black}'`),
  notes: 'CueDeck: таймер старт / пауза. Время выходит — кнопка мигает.',
})

// [ряд][колонка]
const grid: Record<number, Record<number, ReturnType<typeof button>>> = {
  0: {
    0: timerButton,
    1: button({ cmd: 'timer/restart', label: '↺ СТАРТ\nзаново' }),
    2: button({ cmd: 'timer/add/1', label: '+1\nмин', size: 36 }),
    3: button({ cmd: 'timer/sub/1', label: '−1\nмин', size: 36 }),
    4: button({
      cmd: 'blackout/toggle',
      label: 'ЗАСТАВКА',
      size: 25,
      bg: when(`${cv('cuedeck_blackout')} == '1'`, C.redBg, C.black),
    }),
    5: button({ cmd: 'timer/set/5', label: 'ТАЙМЕР\n5 мин' }),
    6: button({ cmd: 'timer/set/10', label: 'ТАЙМЕР\n10 мин' }),
    7: button({ cmd: 'timer/set/15', label: 'ТАЙМЕР\n15 мин' }),
  },
  1: {
    0: button({ cmd: 'prev', label: '◀\nНАЗАД' }),
    1: button({
      cmd: 'next',
      label: 'ДАЛЕЕ ▶',
      // `+` в выражениях Companion складывает только числа — строки через concat().
      value: x(`${cv('cuedeck_slide')} == '' ? '' : concat('ост ', ${cv('cuedeck_slides_left')})`),
      bg: when(`${cv('cuedeck_slides_left')} == '0'`, C.amberBg, C.black),
      notes: 'CueDeck: далее, как кликер. «ост» — сколько слайдов осталось; на последнем фон жёлтый.',
    }),
    2: button({
      cmd: 'take',
      label: 'ЭФИР ▶',
      value: cv('cuedeck_preview'),
      bg: C.redBg,
      notes: 'CueDeck: ЭФИР — превью уходит в зал. Внизу — что сейчас в превью.',
    }),
    3: button({
      cmd: 'playlist/next',
      label: 'СЛЕД. →\nпревью',
      value: cv('cuedeck_next'),
      notes: 'CueDeck: следующий спикер в превью. Внизу — кого поставит.',
    }),
    4: button({
      cmd: 'video/toggle',
      label: 'РОЛИК ▶⏸',
      value: cv('cuedeck_video'),
      bg: when(`${cv('cuedeck_video_playing')} == '1'`, C.greenBg, C.black),
      notes: 'CueDeck: ролик в эфире пуск / пауза. Внизу — сколько осталось; играет — фон зелёный.',
    }),
    // 5, 6 — свободны: листание превью с деки убрано (Азат 2026-09-24 — превью
    // оператор листает у себя на экране; команды preview/* в API остались).
    7: button({ cmd: 'playlist/prev', label: '← ПРЕД.\nпревью' }),
  },
  2: {
    0: button({ cmd: 'video/restart', label: 'РОЛИК\nс начала' }),
    1: button({
      cmd: 'video/mute/toggle',
      label: 'ЗВУК',
      value: when(`${cv('cuedeck_muted')} == '1'`, 'выкл', 'вкл'),
      bg: when(`${cv('cuedeck_muted')} == '1'`, C.redBg, C.black),
    }),
    // Текст пресета оператор правит в CueDeck, поэтому на кнопке — номер, не текст.
    2: button({ cmd: 'message/preset/1', label: 'СПИКЕРУ\nтекст 1' }),
    3: button({
      cmd: 'message/clear',
      label: 'УБРАТЬ\nтекст',
      bg: when(`${cv('cuedeck_message')} != ''`, C.amberBg, C.black),
    }),
    4: button({ cmd: 'timer/full', label: 'ТОЛЬКО\nТАЙМЕР ⛶' }),
    5: button({ cmd: 'video/back/10', label: 'РОЛИК\n−10 с' }),
    6: button({ cmd: 'video/forward/10', label: 'РОЛИК\n+10 с' }),
    7: button({ cmd: 'timer/reset', label: 'ТАЙМЕР\nсброс' }),
  },
  3: Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [i, button({ cmd: `playlist/select/${i + 1}`, label: `СПИКЕР\n${i + 1}`, notes: `CueDeck: запись ${i + 1} плейлиста — в превью (номер на карточке)` })]),
  ),
}

const controls: Record<string, Record<string, unknown>> = {}
for (const [r, cols] of Object.entries(grid)) {
  controls[r] = {}
  for (const [c, b] of Object.entries(cols)) controls[r][c] = b
}

const customVariables = Object.fromEntries(
  Object.entries(COMPANION_VARS).map(([name, description], i) => [
    name,
    { description: `CueDeck — ${description}`, defaultValue: '', persistCurrentValue: false, sortOrder: i },
  ]),
)

const config = {
  version: 12,
  type: 'full',
  companionBuild: COMPANION_BUILD,
  pages: {
    '1': {
      id: 'cuedeckPage',
      name: 'CueDeck',
      controls,
      gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 },
    },
  },
  triggers: {},
  triggerCollections: [],
  custom_variables: customVariables,
  customVariablesCollections: [],
  expressionVariables: {},
  expressionVariablesCollections: [],
  instances: {
    [CONN_ID]: {
      moduleInstanceType: 'connection',
      moduleId: 'generic-http',
      moduleVersionId: '3.1.1',
      updatePolicy: 'stable',
      sortOrder: 0,
      label: 'cuedeck',
      isFirstInit: false,
      config: { prefix: HTTP_BASE, proxyAddress: '', rejectUnauthorized: true, insecureHTTPParser: false },
      secrets: {},
      lastUpgradeIndex: 2,
      enabled: true,
    },
  },
  connectionCollections: [],
  imageLibrary: [],
  imageLibraryCollections: [],
}

const out = resolve(__dirname, 'CueDeck.companionconfig')
writeFileSync(out, JSON.stringify(config, null, '\t') + '\n')
const count = Object.values(controls).reduce((n, r) => n + Object.keys(r).length, 0)
console.log(`→ ${out}: ${count} кнопок, ${Object.keys(customVariables).length} переменных`)
