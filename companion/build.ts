/**
 * Сборка готовой страницы Bitfocus Companion для CueDeck:
 *   npx vite-node companion/build.ts   →   companion/CueDeck.companionconfig (RU)
 *                                          companion/CueDeck.en.companionconfig (EN)
 *
 * Две страницы — по языку интерфейса CueDeck: «Страница Companion…» отдаёт ту,
 * что совпадает с ним (server.ts). Подписи — таблица LABELS ниже, английские —
 * те же слова, что у модуля Companion (companion-module/src/presets.ts).
 *
 * Файл импортируется в Companion (Import / Export) и приносит всё сразу:
 * страницу кнопок, подключение Generic HTTP к CueDeck и custom-переменные,
 * в которые CueDeck сам пишет состояние (src/main/remote/companion-vars.ts).
 * Формат — JSON экспорта Companion 5 (version 12), снят с живой установки
 * 5.0.6: у каждого свойства пара { value, isExpression }.
 *
 * Страницы (сетка 8×4 под Stream Deck XL). Шаблон — библиотека кнопок, а не
 * раскладка под конкретную деку: оператор импортирует его, потом удаляет,
 * копирует и правит кнопки. Каждая команда CueDeck есть хотя бы в одной
 * кнопке (tests/companion-page.test.ts следит за этим).
 *   1 «CueDeck» — рабочий пульт, ряд = группа:
 *     ряд 0 таймер (старт/пауза, заново, сброс, пресеты 1–4, ⛶),
 *     ряд 1 поправка ±10…±1 мин,
 *     ряд 2 «Эфир» — что в зале: окошко В ЭФИРЕ (имя, слайд; без действия),
 *       назад, далее, ролик, с начала, звук, заставка, стрим,
 *     ряд 3 «Подготовка» — превью и суфлёр: окошко ПРЕВЬЮ (без действия),
 *       ◀ / ▶ в превью, TAKE, сообщение (пресет 1, свой текст, убрать), лампа OMT.
 *   2 «ещё кнопки 1» — ряды: эфир / плейлист и превью / ролик (с ±10 с) / звук и цикл.
 *   3 «ещё кнопки 2» — ряды: таймер / режим / положение на суфлёре /
 *     сообщения (пресеты 2, 3) и трансляция вкл/выкл.
 * Кнопки-образцы с числом или текстом (спикер N, слайд N, таймер N мин, свой
 * текст) хранят значение в переменной самой кнопки (Local Variables, в
 * адресе и подписи это `$(local:имя)`) — у копии правят одно поле.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COMPANION_VARS, COMPANION_VARS_EN } from '../src/main/remote/companion-vars'

type Lang = 'ru' | 'en'

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

const LABELS = {
  ru: {
    timer: 'ТАЙМЕР',
    offline: 'нет связи',
    presetNotes: 'CueDeck: пресет таймера {n}: ставит ровно это время (без запуска). Минуты берутся из CueDeck, пресет правится там.',
    timerNotes: 'CueDeck: таймер старт / пауза. Время выходит — кнопка мигает.',
    restart: '↺ СТАРТ\nзаново',
    min: 'мин',
    blackout: 'ЗАСТАВКА',
    back: '◀\nНАЗАД',
    next: 'ДАЛЕЕ ▶',
    left: 'ост ',
    nextNotes: 'CueDeck: далее, как кликер. «ост» — сколько слайдов осталось; на последнем фон жёлтый.',
    take: 'TAKE ▶\nпревью → эфир',
    takeNotes: 'CueDeck: TAKE — превью уходит в зал.',
    toPreviewNext: 'В ПРЕВЬЮ ▶',
    toPreviewNextNotes: 'CueDeck: следующая запись плейлиста — в превью (не в зал).',
    onAirWin: 'В ЭФИРЕ',
    onAirBlackout: 'ЗАСТАВКА',
    onAirNotes: 'Только показывает, нажатие ничего не делает. Что сейчас в зале: имя и слайд; красный — идёт, янтарный — заставка.',
    previewWin: 'ПРЕВЬЮ',
    previewWinNotes: 'Только показывает, нажатие ничего не делает. Что стоит в превью; зелёный — что-то есть.',
    video: 'РОЛИК ▶⏸',
    videoNotes: 'CueDeck: ролик в эфире пуск / пауза. Внизу — сколько осталось; играет — фон зелёный.',
    prevSpeaker: '◀ В ПРЕВЬЮ',
    videoRestart: 'РОЛИК\nс начала',
    sound: 'ЗВУК',
    soundOff: 'выкл',
    soundOn: 'вкл',
    message: 'СПИКЕРУ',
    msgNotes: 'CueDeck: пресет сообщения {n} спикеру; внизу его текст. Янтарная, пока он на экране суфлёра. Текст правится в CueDeck.',
    clearMsg: 'УБРАТЬ\nтекст',
    full: 'ТОЛЬКО\nТАЙМЕР ⛶',
    videoBack: 'РОЛИК\n−10 с',
    videoFwd: 'РОЛИК\n+10 с',
    reset: 'ТАЙМЕР\nсброс',
    omt: 'OMT',
    omtAir: 'ЭФИР',
    omtPreview: 'ПРЕВЬЮ',
    omtOff: 'выкл',
    omtNotes: 'CueDeck: лампа выхода OMT «Зал», без действия при нажатии. Красная — vMix держит нас в эфире, работать осторожно; зелёная — в превью. «выкл» — выход выключен.',
    stream: 'СТРИМ',
    streamNotes: 'CueDeck: старт/стоп трансляции. Внизу — площадок в эфире/включено; фон жёлтый — проблема (сеть, площадка, картинка).',
    vars: COMPANION_VARS as Record<string, string>,
  },
  en: {
    timer: 'TIMER',
    offline: 'offline',
    presetNotes: 'CueDeck: timer preset {n}: sets exactly this time (does not start). The minutes come from CueDeck, edit the preset there.',
    timerNotes: 'CueDeck: timer start / pause. When time is up, the key blinks.',
    restart: '↺ RESTART',
    min: 'min',
    blackout: 'BLACKOUT',
    back: '◀\nBACK',
    next: 'NEXT ▶',
    left: 'left ',
    nextNotes: 'CueDeck: next, like the clicker. “left” — slides remaining; amber on the last slide.',
    take: 'TAKE ▶\npreview → air',
    takeNotes: 'CueDeck: TAKE — the preview goes to the audience.',
    toPreviewNext: 'TO PREVIEW ▶',
    toPreviewNextNotes: 'CueDeck: next playlist entry into preview (not to the audience).',
    onAirWin: 'ON AIR',
    onAirBlackout: 'BLACKOUT',
    onAirNotes: 'Display only, pressing does nothing. What the audience sees now: name and slide; red — live, amber — blackout.',
    previewWin: 'PREVIEW',
    previewWinNotes: 'Display only, pressing does nothing. What is in preview; green — something is loaded.',
    video: 'VIDEO ▶⏸',
    videoNotes: 'CueDeck: clip on air play / pause. Bottom line — time left; green while playing.',
    prevSpeaker: '◀ TO PREVIEW',
    videoRestart: 'VIDEO\nfrom start',
    sound: 'SOUND',
    soundOff: 'off',
    soundOn: 'on',
    message: 'MESSAGE',
    msgNotes: 'CueDeck: speaker message preset {n}; its text below. Amber while it is on the prompter. Edit the text in CueDeck.',
    clearMsg: 'CLEAR\nmessage',
    full: 'TIMER\nONLY ⛶',
    videoBack: 'VIDEO\n−10 s',
    videoFwd: 'VIDEO\n+10 s',
    reset: 'TIMER\nreset',
    omt: 'OMT',
    omtAir: 'ON AIR',
    omtPreview: 'PREVIEW',
    omtOff: 'off',
    omtNotes: 'CueDeck: lamp of the Program OMT output, pressing does nothing. Red — vMix has us on air, be careful; green — in preview. “off” — the output is off.',
    stream: 'STREAM',
    streamNotes: 'CueDeck: start/stop the broadcast. Bottom line — destinations live/enabled; amber background — something is wrong (network, destination, no picture).',
    vars: COMPANION_VARS_EN as Record<string, string>,
  },
} satisfies Record<Lang, Record<string, unknown>>


/**
 * Подписи и заметки кнопок-библиотеки (страницы 2–3). Ключ — id кнопки в
 * `libraryPages()`. Подпись — две короткие строки, заметка — по-человечески.
 */
const LIB = {
  ru: {
    goto: ['СЛАЙД', 'Перейти к слайду в эфире. Номер слайда хранится в переменной кнопки n. Скопируй кнопку и поменяй значение переменной кнопки: вкладка Local Variables.'],
    bkOn: ['ЗАСТАВКА\nвкл', 'Включить заставку (blackout). Уже включена — ничего не делает. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
    bkOff: ['ЗАСТАВКА\nвыкл', 'Выключить заставку. Красная, пока заставка включена. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
    plSelect: ['СПИКЕР', 'Запись плейлиста в превью. Номер = номер на карточке в CueDeck, хранится в переменной кнопки n. Скопируй кнопку и поменяй значение переменной кнопки: вкладка Local Variables. Лампа: красная — запись в эфире, зелёная — в превью.'],
    plAir: ['СПИКЕР → ЭФИР', 'Запись плейлиста сразу в эфир, минуя превью. Номер в переменной кнопки n. Скопируй кнопку и поменяй значение переменной кнопки: вкладка Local Variables. Лампа: красная — в эфире, зелёная — в превью.'],
    pvNext: ['ПРЕВЬЮ\nслайд ▶', 'Листнуть слайд в превью.'],
    pvPrev: ['ПРЕВЬЮ\n◀ слайд', 'Листнуть слайд в превью назад.'],
    pvGoto: ['ПРЕВЬЮ СЛАЙД', 'Превью: перейти к слайду. Номер в переменной кнопки n. Скопируй кнопку и поменяй значение переменной кнопки: вкладка Local Variables.'],
    pvVideo: ['ПРЕВЬЮ\nролик ▶⏸', 'Ролик в превью: пуск / пауза.'],
    pvClear: ['ПРЕВЬЮ\nочистить', 'Очистить превью.'],
    vPlay: ['РОЛИК\n▶ пуск', 'Пуск ролика в эфире. Зелёная, пока играет.'],
    vPause: ['РОЛИК\n⏸ пауза', 'Пауза ролика в эфире.'],
    vStop: ['РОЛИК\nстоп', 'Стоп: пауза на первом кадре.'],
    vBack: ['РОЛИК\n−10 с', 'Назад на 10 секунд. Число меняется в адресе действия.'],
    vFwd: ['РОЛИК\n+10 с', 'Вперёд на 10 секунд. Число меняется в адресе действия.'],
    muteOn: ['ЗВУК\nвыкл', 'Выключить звук эфира. Красная, пока звук выключен. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
    muteOff: ['ЗВУК\nвкл', 'Включить звук эфира. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
    loopT: ['ЦИКЛ', 'Цикл ролика: переключить.'],
    loopOn: ['ЦИКЛ\nвкл', 'Включить цикл ролика. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
    loopOff: ['ЦИКЛ\nвыкл', 'Выключить цикл ролика. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
    tStart: ['СТАРТ', 'Запустить таймер.'],
    tPause: ['ПАУЗА', 'Поставить таймер на паузу.'],
    tSet20: ['ТАЙМЕР', 'Ставит ровно столько минут (без запуска). Минуты в переменной кнопки min: 20, можно 1:30 или 90s. Скопируй кнопку и поменяй значение переменной кнопки: вкладка Local Variables.'],
    mCount: ['ОБРАТНЫЙ\nОТСЧЁТ', 'Режим таймера: обратный отсчёт.'],
    mStop: ['СЕКУНДО-\nМЕР', 'Режим таймера: секундомер.'],
    mClock: ['ЧАСЫ', 'Режим таймера: часы.'],
    'top-left': ['ТАЙМЕР\n↖', 'Таймер на суфлёре: слева вверху.'],
    'top-right': ['ТАЙМЕР\n↗', 'Таймер на суфлёре: справа вверху.'],
    'bottom-left': ['ТАЙМЕР\n↙', 'Таймер на суфлёре: слева внизу.'],
    'bottom-right': ['ТАЙМЕР\n↘', 'Таймер на суфлёре: справа внизу.'],
    hidden: ['ТАЙМЕР\nскрыт', 'Спрятать таймер на суфлёре.'],
    full: ['ТОЛЬКО\nТАЙМЕР', 'Суфлёр целиком отдан таймеру, со вспышкой на нуле.'],
    'full-noflash': ['БЕЗ\nВСПЫШКИ', 'Суфлёр целиком отдан таймеру, без вспышки на нуле.'],
    free: ['ТАЙМЕР\nсвободно', 'Таймер в том месте, куда его поставили мышкой в Настройках → Суфлёр.'],
    mText: ['СВОЙ ТЕКСТ', 'Показать спикеру свой текст. Текст хранится в переменной кнопки text. Скопируй кнопку и поменяй значение переменной кнопки: вкладка Local Variables. Янтарная, пока этот текст на суфлёре.'],
    sOn: ['СТРИМ\nвкл', 'Включить трансляцию. Красная, пока идёт. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
    sOff: ['СТРИМ\nвыкл', 'Остановить трансляцию. Отдельные вкл и выкл нужны для кнопок из нескольких команд, например «спикер в эфир + снять заставку»: переключатель сработает наоборот, если заставка уже снята.'],
  },
  en: {
    goto: ['SLIDE', 'Go to a slide on air. The slide number is the button variable n. Copy the button and change the button variable: the Local Variables tab.'],
    bkOn: ['BLACKOUT\non', 'Blackout on. Does nothing if it is already on. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
    bkOff: ['BLACKOUT\noff', 'Blackout off. Red while blackout is on. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
    plSelect: ['SPEAKER', 'Playlist entry into preview. The number is the one on the card in CueDeck, kept in the button variable n. Copy the button and change the button variable: the Local Variables tab. Lamp: red — on air, green — in preview.'],
    plAir: ['SPEAKER → AIR', 'Playlist entry straight on air, skipping preview. The number is the button variable n. Copy the button and change the button variable: the Local Variables tab. Lamp: red — on air, green — in preview.'],
    pvNext: ['PREVIEW\nslide ▶', 'Next slide in preview.'],
    pvPrev: ['PREVIEW\n◀ slide', 'Previous slide in preview.'],
    pvGoto: ['PREVIEW SLIDE', 'Preview: go to a slide. The number is the button variable n. Copy the button and change the button variable: the Local Variables tab.'],
    pvVideo: ['PREVIEW\nvideo ▶⏸', 'Video in preview: play / pause.'],
    pvClear: ['PREVIEW\nclear', 'Clear the preview.'],
    vPlay: ['VIDEO\n▶ play', 'Play the clip on air. Green while playing.'],
    vPause: ['VIDEO\n⏸ pause', 'Pause the clip on air.'],
    vStop: ['VIDEO\nstop', 'Stop: pause on the first frame.'],
    vBack: ['VIDEO\n−10 s', 'Back 10 seconds. Change the number in the action URL.'],
    vFwd: ['VIDEO\n+10 s', 'Forward 10 seconds. Change the number in the action URL.'],
    muteOn: ['SOUND\noff', 'Mute the program sound. Red while muted. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
    muteOff: ['SOUND\non', 'Unmute the program sound. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
    loopT: ['LOOP', 'Clip loop: toggle.'],
    loopOn: ['LOOP\non', 'Loop on. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
    loopOff: ['LOOP\noff', 'Loop off. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
    tStart: ['START', 'Start the timer.'],
    tPause: ['PAUSE', 'Pause the timer.'],
    tSet20: ['TIMER', 'Sets exactly that many minutes (does not start). The minutes are the button variable min: 20, also 1:30 or 90s. Copy the button and change the button variable: the Local Variables tab.'],
    mCount: ['COUNT\nDOWN', 'Timer mode: countdown.'],
    mStop: ['STOP\nWATCH', 'Timer mode: stopwatch.'],
    mClock: ['CLOCK', 'Timer mode: clock.'],
    'top-left': ['TIMER\n↖', 'Timer on the prompter: top left.'],
    'top-right': ['TIMER\n↗', 'Timer on the prompter: top right.'],
    'bottom-left': ['TIMER\n↙', 'Timer on the prompter: bottom left.'],
    'bottom-right': ['TIMER\n↘', 'Timer on the prompter: bottom right.'],
    hidden: ['TIMER\nhidden', 'Hide the timer on the prompter.'],
    full: ['TIMER\nONLY', 'The whole prompter screen is the timer, with a flash at zero.'],
    'full-noflash': ['NO\nFLASH', 'The whole prompter screen is the timer, no flash at zero.'],
    free: ['TIMER\nfree', 'Timer where you dragged it in Settings → Prompter.'],
    mText: ['CUSTOM TEXT', 'Show your own text to the speaker. The text is the button variable text. Copy the button and change the button variable: the Local Variables tab. Amber while this text is on the prompter.'],
    sOn: ['STREAM\non', 'Start the broadcast. Red while live. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
    sOff: ['STREAM\noff', 'Stop the broadcast. Separate on and off are for multi-command buttons, e.g. “speaker on air + clear blackout”: a toggle does the opposite if the blackout is already off.'],
  },
} as const satisfies Record<Lang, Record<string, readonly [string, string]>>

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
  /** Путь команды CueDeck: `timer/toggle` (см. «Список команд»). Без него кнопка — лампа, нажатие ничего не делает. */
  cmd?: string
  /** Верхняя подпись — что делает кнопка. */
  label: string | Prop
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
  /**
   * Переменные самой кнопки (Local Variables): имя → значение. В адресе, подписи
   * и выражениях кнопки они доступны как `$(local:имя)`. Копию кнопки правят
   * в одном месте — на вкладке Local Variables.
   */
  locals?: Record<string, string>
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
      notes: b.notes ?? `CueDeck: ${b.cmd ?? ''}`,
    },
    feedbacks: [],
    steps: {
      '0': {
        action_sets: {
          down: b.cmd === undefined ? [] : [
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
    localVariables: Object.entries(b.locals ?? {}).map(([name, value]) => ({
      id: uid('lv'),
      type: 'feedback',
      definitionId: 'user_value',
      connectionId: 'internal',
      variableName: name,
      options: { persist_value: v(false), startup_value: v(value) },
      isInverted: v(false),
    })),
  }
}

function build(lang: Lang, file: string): void {
  seq = 0 // одинаковые id при каждой сборке — дифф файла показывает только настоящие правки
  const T = LABELS[lang]
  // Связь есть: CueDeck не попрощался и слал данные меньше 10 с назад (упал —
  // попрощаться не успел, и без этой проверки кнопка показывала бы замершее время).
  // Часы Companion и CueDeck должны совпадать (обычно они синхронизированы по сети).
  const online = `${cv('cuedeck_online')} == '1' && $(internal:time_unix) - ${cv('cuedeck_seen')} < 10`
  const when = (cond: string, yes: string, no: string): Prop => x(`${cond} ? '${yes}' : '${no}'`)

  // Таймер: цвет цифр как на суфлёре, на нуле фон мигает красным.
  const timerButton = button({
    cmd: 'timer/toggle',
    label: T.timer,
    value: x(`${online} ? ${cv('cuedeck_timer')} : '${T.offline}'`),
    valueColor: x(
      `!(${online}) ? '${C.muted}' : ` +
        `${cv('cuedeck_timer_over')} == '1' ? '${C.white}' : ` +
        `${cv('cuedeck_timer_color')} == 'green' ? '${C.green}' : ` +
        `${cv('cuedeck_timer_color')} == 'yellow' ? '${C.yellow}' : ` +
        `${cv('cuedeck_timer_color')} == 'red' ? '${C.red}' : '${C.white}'`,
    ),
    bg: x(`${cv('cuedeck_timer_over')} == '1' && blink(500) ? '${C.blinkRed}' : '${C.black}'`),
    notes: T.timerNotes,
  })

  const L = LIB[lang]
  const lib = (cmd: string, key: keyof typeof L, extra: Partial<ButtonSpec> = {}) =>
    button({ cmd, label: L[key][0], notes: L[key][1], size: 25, ...extra })
  const msgText = lang === 'ru' ? 'Время!' : "Time's up"
  const lv = (name: string) => `$(local:${name})`
  const amberWhenShown = (text: string): Prop =>
    when(`${cv('cuedeck_message')} != '' && ${cv('cuedeck_message')} == ${text}`, C.amberBg, C.black)
  // Кнопка-образец с номером в переменной кнопки: лампа красная — запись в эфире, зелёная — в превью.
  const entryLamp = (): Prop =>
    x(
      `${cv('cuedeck_program_index')} == ${lv('n')} ? '${C.redBg}' : ` +
        `${cv('cuedeck_preview_index')} == ${lv('n')} ? '${C.greenBg}' : '${C.black}'`,
    )
  const sampleN = (cmdBase: string, key: keyof typeof L, label: string, extra: Partial<ButtonSpec> = {}) =>
    lib(`${cmdBase}/${lv('n')}`, key, { label, value: lv('n'), locals: { n: '1' }, ...extra })
  // Сообщение-пресет N: «СПИКЕРУ» и ниже его текст из CueDeck; янтарная, пока текст на суфлёре.
  const msgPresetButton = (n: number) =>
    button({
      cmd: `message/preset/${n}`,
      label: T.message,
      value: cv(`cuedeck_message_preset_${n}` as keyof typeof COMPANION_VARS),
      bg: amberWhenShown(cv(`cuedeck_message_preset_${n}` as keyof typeof COMPANION_VARS)),
      notes: T.msgNotes.replace('{n}', String(n)),
    })
  const customTextButton = () =>
    lib(`message/text/${lv('text')}`, 'mText', { value: lv('text'), locals: { text: msgText }, bg: amberWhenShown(lv('text')) })

  // Пресет таймера из CueDeck: «ТАЙМЕР / 5 мин»; пресета нет — тусклое «—».
  const presetButton = (n: number) => {
    const pv = cv(`cuedeck_timer_preset_${n}` as keyof typeof COMPANION_VARS)
    return button({
      cmd: `timer/preset/${n}`,
      label: T.timer,
      value: x(`${pv} == '' ? '—' : concat(${pv}, ' ${T.min}')`),
      valueColor: x(`${pv} == '' ? '${C.muted}' : '${C.white}'`),
      notes: T.presetNotes.replace('{n}', String(n)),
    })
  }

  // [ряд][колонка]. Ряд = группа: таймер / поправка таймера / эфир / ролик и сообщения.
  const grid: Record<number, Record<number, ReturnType<typeof button>>> = {
    0: {
      0: timerButton,
      1: button({ cmd: 'timer/restart', label: T.restart }),
      2: button({ cmd: 'timer/reset', label: T.reset }),
      3: presetButton(1),
      4: presetButton(2),
      5: presetButton(3),
      6: presetButton(4),
      7: button({ cmd: 'timer/full', label: T.full }),
    },
    // Поправка таймера: −10 −5 −3 −1 +1 +3 +5 +10 минут.
    1: Object.fromEntries(
      [-10, -5, -3, -1, 1, 3, 5, 10].map((m, i) => [
        i,
        button({
          cmd: `timer/${m < 0 ? 'sub' : 'add'}/${Math.abs(m)}`,
          label: `${m < 0 ? '−' : '+'}${Math.abs(m)}\n${T.min}`,
          size: 36,
        }),
      ]),
    ),
    // Ряд 2 «Эфир»: что в зале.
    2: {
      0: button({
        label: x(`${cv('cuedeck_slide')} == '' ? '${T.onAirWin}' : concat('${T.onAirWin} ', ${cv('cuedeck_slide')})`),
        value: x(
          `${cv('cuedeck_blackout')} == '1' ? '${T.onAirBlackout}' : ` +
            `${cv('cuedeck_program')} == '' ? '—' : ${cv('cuedeck_program')}`,
        ),
        valueColor: x(
          `${cv('cuedeck_blackout')} != '1' && ${cv('cuedeck_program')} == '' ? '${C.muted}' : '${C.white}'`,
        ),
        bg: x(
          `${cv('cuedeck_blackout')} == '1' ? '${C.amberBg}' : ` +
            `${cv('cuedeck_program')} != '' ? '${C.redBg}' : '${C.black}'`,
        ),
        notes: T.onAirNotes,
      }),
      1: button({ cmd: 'prev', label: T.back }),
      2: button({
        cmd: 'next',
        label: T.next,
        // `+` в выражениях Companion складывает только числа — строки через concat().
        value: x(`${cv('cuedeck_slide')} == '' ? '' : concat('${T.left}', ${cv('cuedeck_slides_left')})`),
        bg: when(`${cv('cuedeck_slides_left')} == '0'`, C.amberBg, C.black),
        notes: T.nextNotes,
      }),
      3: button({
        cmd: 'video/toggle',
        label: T.video,
        value: cv('cuedeck_video'),
        bg: when(`${cv('cuedeck_video_playing')} == '1'`, C.greenBg, C.black),
        notes: T.videoNotes,
      }),
      4: button({ cmd: 'video/restart', label: T.videoRestart }),
      5: button({
        cmd: 'video/mute/toggle',
        label: T.sound,
        value: when(`${cv('cuedeck_muted')} == '1'`, T.soundOff, T.soundOn),
        bg: when(`${cv('cuedeck_muted')} == '1'`, C.redBg, C.black),
      }),
      6: button({
        cmd: 'blackout/toggle',
        label: T.blackout,
        size: 25,
        bg: when(`${cv('cuedeck_blackout')} == '1'`, C.redBg, C.black),
      }),
      7: button({
        cmd: 'stream/toggle',
        label: T.stream,
        value: x(
          `${cv('cuedeck_stream_total')} == '0' ? '' : concat(${cv('cuedeck_stream_live')}, concat('/', ${cv('cuedeck_stream_total')}))`,
        ),
        bg: x(
          `${cv('cuedeck_stream_running')} == '1' && ${cv('cuedeck_stream_warn')} == '1' && blink(500) ? '${C.amberBg}' : ` +
            `${cv('cuedeck_stream_running')} == '1' ? '${C.redBg}' : '${C.black}'`,
        ),
        notes: T.streamNotes,
      }),
    },
    // Ряд 3 «Подготовка»: превью и суфлёр.
    3: {
      0: button({
        label: T.previewWin,
        value: x(`${cv('cuedeck_preview')} == '' ? '—' : ${cv('cuedeck_preview')}`),
        valueColor: x(`${cv('cuedeck_preview')} == '' ? '${C.muted}' : '${C.white}'`),
        bg: when(`${cv('cuedeck_preview')} != ''`, C.greenBg, C.black),
        notes: T.previewWinNotes,
      }),
      1: button({ cmd: 'playlist/prev', label: T.prevSpeaker, size: 25 }),
      2: button({ cmd: 'playlist/next', label: T.toPreviewNext, size: 25, notes: T.toPreviewNextNotes }),
      3: button({ cmd: 'take', label: T.take, size: 25, bg: C.redBg, notes: T.takeNotes }),
      4: msgPresetButton(1),
      5: customTextButton(),
      6: button({
        cmd: 'message/clear',
        label: T.clearMsg,
        bg: when(`${cv('cuedeck_message')} != ''`, C.amberBg, C.black),
      }),
      // Лампа OMT (выход «Зал»): без действия.
      7: button({
        label: T.omt,
        value: x(
          `${cv('cuedeck_omt_program')} == '1' ? '${T.omtAir}' : ` +
            `${cv('cuedeck_omt_preview')} == '1' ? '${T.omtPreview}' : ` +
            `${cv('cuedeck_omt_on')} == '1' ? '' : '${T.omtOff}'`,
        ),
        valueColor: x(`${cv('cuedeck_omt_on')} == '1' ? '${C.white}' : '${C.muted}'`),
        bg: x(
          `${cv('cuedeck_omt_program')} == '1' ? '${C.redBg}' : ` +
            `${cv('cuedeck_omt_preview')} == '1' ? '${C.greenBg}' : '${C.black}'`,
        ),
        notes: T.omtNotes,
      }),
    },
  }

  // ── Страницы-библиотека: все команды, которых нет на пульте. Ряд = группа. ──
  const mutedBg = when(`${cv('cuedeck_muted')} == '1'`, C.redBg, C.black)
  const row = (...bs: ReturnType<typeof button>[]) => Object.fromEntries(bs.map((b, i) => [i, b]))
  const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'hidden', 'full', 'full-noflash', 'free'] as const
  const libGrids: Record<number, Record<number, ReturnType<typeof button>>>[] = [
    {
      // Эфир и слайды
      0: row(
        sampleN('program/goto', 'goto', L.goto[0]),
        lib('blackout/on', 'bkOn', { bg: when(`${cv('cuedeck_blackout')} == '1'`, C.redBg, C.black) }),
        lib('blackout/off', 'bkOff'),
      ),
      // Плейлист и превью
      1: row(
        sampleN('playlist/select', 'plSelect', L.plSelect[0], { bg: entryLamp() }),
        sampleN('playlist/air', 'plAir', L.plAir[0], { bg: entryLamp() }),
        lib('preview/next', 'pvNext'),
        lib('preview/prev', 'pvPrev'),
        sampleN('preview/goto', 'pvGoto', L.pvGoto[0]),
        lib('preview/video/toggle', 'pvVideo'),
        lib('preview/clear', 'pvClear'),
      ),
      // Ролик
      2: row(
        lib('video/play', 'vPlay', { bg: when(`${cv('cuedeck_video_playing')} == '1'`, C.greenBg, C.black) }),
        lib('video/pause', 'vPause'),
        lib('video/stop', 'vStop'),
        lib('video/back/10', 'vBack'),
        lib('video/forward/10', 'vFwd'),
      ),
      // Звук и цикл ролика
      3: row(
        lib('video/mute/on', 'muteOn', { bg: mutedBg }),
        lib('video/mute/off', 'muteOff'),
        lib('video/loop/toggle', 'loopT'),
        lib('video/loop/on', 'loopOn'),
        lib('video/loop/off', 'loopOff'),
      ),
    },
    {
      // Таймер
      0: row(
        lib('timer/start', 'tStart'),
        lib('timer/pause', 'tPause'),
        lib(`timer/set/${lv('min')}`, 'tSet20', {
          value: x(`concat(${lv('min')}, ' ${T.min}')`),
          locals: { min: '20' },
        }),
      ),
      // Режим таймера
      1: row(lib('timer/mode/countdown', 'mCount'), lib('timer/mode/stopwatch', 'mStop'), lib('timer/mode/clock', 'mClock')),
      // Положение таймера на суфлёре
      2: row(...positions.map((p) => lib(`timer/position/${p}`, p))),
      // Сообщение спикеру и трансляция в одном ряду
      3: {
        ...row(
          msgPresetButton(2),
          msgPresetButton(3),
        ),
        2: lib('stream/on', 'sOn', { bg: when(`${cv('cuedeck_stream_running')} == '1'`, C.redBg, C.black) }),
        3: lib('stream/off', 'sOff'),
      },
    },
  ]

  const toControls = (g: Record<number, Record<number, ReturnType<typeof button>>>) => {
    const controls: Record<string, Record<string, unknown>> = {}
    for (const [r, cols] of Object.entries(g)) {
      controls[r] = {}
      for (const [c, b] of Object.entries(cols)) controls[r][c] = b
    }
    return controls
  }
  const pageDefs = [
    { id: 'cuedeckPage', name: 'CueDeck', grid },
    { id: 'cuedeckPage2', name: lang === 'ru' ? 'CueDeck: ещё кнопки 1' : 'CueDeck: more buttons 1', grid: libGrids[0] },
    { id: 'cuedeckPage3', name: lang === 'ru' ? 'CueDeck: ещё кнопки 2' : 'CueDeck: more buttons 2', grid: libGrids[1] },
  ]
  const pages = Object.fromEntries(
    pageDefs.map((p, i) => [
      String(i + 1),
      { id: p.id, name: p.name, controls: toControls(p.grid), gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 } },
    ]),
  )

  const customVariables = Object.fromEntries(
    Object.keys(COMPANION_VARS).map((name, i) => [
      name,
      { description: `CueDeck — ${T.vars[name]}`, defaultValue: '', persistCurrentValue: false, sortOrder: i },
    ]),
  )

  const config = {
    version: 12,
    type: 'full',
    companionBuild: COMPANION_BUILD,
    pages,
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

  const out = resolve(__dirname, file)
  writeFileSync(out, JSON.stringify(config, null, '\t') + '\n')
  const count = pageDefs.reduce((n, p) => n + Object.values(p.grid).reduce((m, r) => m + Object.keys(r).length, 0), 0)
  console.log(`→ ${out}: ${count} кнопок, ${Object.keys(customVariables).length} переменных`)
}

build('ru', 'CueDeck.companionconfig')
build('en', 'CueDeck.en.companionconfig')
