import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EN, EN_HTML } from '../src/shared/i18n-en'
import { DEFAULT_LANG, setLang, t } from '../src/shared/i18n'
import { REMOTE_COMMANDS } from '../src/main/remote/commands'
import { DEFAULT_SPEAKER_MSG_PRESETS } from '../src/shared/types'

/**
 * Английский интерфейс (src/shared/i18n.ts). Ключ словаря — русский текст,
 * поэтому забытый перевод не ломает сборку, а молча оставляет русский. Тесты
 * ниже находят такие места: каждый русский текст в HTML и в t('…') должен
 * быть в словаре, а русский текст вне t() — только там, где он нужен по-русски
 * (журнал, отчёт для разработчика), с пометкой `i18n-ok` в строке.
 */

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')
const CYR = /[А-Яа-яЁё]/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const TS_FILES = walk(SRC).filter((p) => p.endsWith('.ts') && !p.endsWith('i18n-en.ts'))
const HTML_FILES = walk(SRC).filter((p) => p.endsWith('.html'))

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Ключи t('…') со строковым литералом (одинарные кавычки, как принято в проекте). */
function tKeys(src: string): string[] {
  const out: string[] = []
  const re = /(?<![\w.])t\(\s*'((?:[^'\\]|\\.)*)'/g
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
  return out
}

/** Текст и подсказки HTML, которые переводит translateDom(). */
function htmlStrings(html: string): { texts: string[]; blocks: string[] } {
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
  const blocks: string[] = []
  s = s.replace(/<(\w+)[^>]*data-i18n-html="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g, (_m, _tag, id: string) => {
    blocks.push(id)
    return ''
  })
  s = s.replace(/<(\w+)[^>]*translate="no"[^>]*>[\s\S]*?<\/\1>/g, '')
  const texts: string[] = []
  for (const m of s.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) {
    if (CYR.test(m[1])) texts.push(norm(m[1]))
  }
  for (const m of s.matchAll(/>([^<]+)</g)) {
    if (CYR.test(m[1])) texts.push(norm(m[1]))
  }
  return { texts, blocks }
}

/**
 * Файлы, где русский текст нужен как есть, — с причиной. Новый файл сюда
 * только осознанно: всё, что видит пользователь, идёт через t().
 */
const RU_FILES: Record<string, string> = {
  'src/main/diag.ts': 'журнал и отчёт о проблеме читает разработчик — по-русски',
  'src/main/pptx-media.ts': 'внутренние ошибки разбора PPTX — только в журнал, разбор откатывается',
  'src/main/remote/osc.ts': 'ошибки разбора OSC-пакета — только в журнал',
  'src/main/lang-dialog.ts': 'окно выбора языка двуязычное по замыслу',
  'src/main/remote/companion-vars.ts': 'описания переменных — ключи словаря, переводятся при сборке страницы Companion',
}

/** Строки-данные: русский — ключ словаря, t() при показе; покрыты тестами ниже. */
const DATA_LINES: Record<string, RegExp> = {
  'src/main/remote/commands.ts': /^\s*(group|title|example): '|^\s*\| '|onOff\(|^\s*'[^']*',$|sec\|с\|сек/,
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

afterEach(() => setLang(DEFAULT_LANG))

describe('словарь EN', () => {
  it('нет пустых переводов, подстановки {…} совпадают', () => {
    for (const [ru, en] of Object.entries(EN)) {
      expect(en.trim(), ru).not.toBe('')
      expect(placeholders(en), ru).toEqual(placeholders(ru))
    }
  })

  it('каждый ключ где-то используется (нет мёртвых строк)', () => {
    const corpus = norm([...TS_FILES, ...HTML_FILES].map((p) => readFileSync(p, 'utf8')).join('\n'))
    const unused = Object.keys(EN).filter((k) => !corpus.includes(norm(k)))
    expect(unused).toEqual([])
  })

  it('t() подставляет и переводит', () => {
    setLang('en')
    expect(t('Слайд {n} из {total}', { n: 3, total: 12 })).toBe('Slide 3 of 12')
    setLang('ru')
    expect(t('Слайд {n} из {total}', { n: 3, total: 12 })).toBe('Слайд 3 из 12')
  })
})

describe('всё русское переведено', () => {
  it('HTML: текст и подсказки', () => {
    const missing: string[] = []
    for (const f of HTML_FILES) {
      const { texts, blocks } = htmlStrings(readFileSync(f, 'utf8'))
      for (const s of texts) if (EN[s] === undefined) missing.push(`${relative(ROOT, f)}: ${s}`)
      for (const b of blocks) if (EN_HTML[b] === undefined) missing.push(`${relative(ROOT, f)}: data-i18n-html="${b}"`)
    }
    expect(missing).toEqual([])
  })

  it("код: каждый t('…')", () => {
    const missing: string[] = []
    for (const f of TS_FILES) {
      for (const k of tKeys(readFileSync(f, 'utf8'))) {
        if (CYR.test(k) && EN[k] === undefined) missing.push(`${relative(ROOT, f)}: ${k}`)
      }
    }
    expect([...new Set(missing)]).toEqual([])
  })

  it('внешнее управление: названия команд, разделы, примеры', () => {
    const missing = REMOTE_COMMANDS.flatMap((c) => [c.title, c.group, c.what ?? '', c.example ?? ''])
      .filter((s) => CYR.test(s) && EN[s] === undefined)
    expect([...new Set(missing)]).toEqual([])
  })

  it('заводские сообщения спикеру', () => {
    for (const p of DEFAULT_SPEAKER_MSG_PRESETS) if (p) expect(EN[p], p).toBeDefined()
  })

  it('нет русского текста мимо t() (кроме помеченного i18n-ok)', () => {
    const bad: string[] = []
    for (const f of TS_FILES) {
      const rel = relative(ROOT, f)
      if (RU_FILES[rel]) continue
      const lines = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n')
      lines.forEach((line, i) => {
        if (line.includes('i18n-ok') || DATA_LINES[rel]?.test(line)) return
        let code = line.replace(/(^|\s)\/\/.*$/, '')
        if (/\b(log|console)\.(info|warn|error|debug|log)\(|diag\.log\(/.test(code)) return
        code = code.replace(/(?<![\w.])t\(\s*'(?:[^'\\]|\\.)*'/g, '')
        if (CYR.test(code)) bad.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })
})
