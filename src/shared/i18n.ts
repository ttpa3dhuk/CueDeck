import { EN } from './i18n-en.js'

/**
 * Язык интерфейса (PLAN «🌍 английский интерфейс»). Устроено как gettext:
 * ключ — сам русский текст, он же остаётся в коде и в HTML как есть. Перевод
 * лежит одним словарём «русская строка → английская» в i18n-en.ts. Забыли
 * перевести — на экране останется русский, а tests/i18n.test.ts покажет,
 * какой строки не хватает.
 *
 * Язык выбирается один раз за запуск: main — при старте (setLang), окна —
 * по адресу страницы (`?lang=en`, его ставит windows.ts). Смена языка в
 * «Настройках» — через перезапуск: половина текста уже нарисована.
 */

export type Lang = 'ru' | 'en'

export const LANGS: readonly Lang[] = ['ru', 'en']

/**
 * Язык, пока не выбран другой: английский — у всех, и у новых установок, и у
 * тех, кто работал в CueDeck до английской версии (Азат 2026-09-25). Русский
 * выбирается в окне первого запуска или в «Настройки → Интерфейс».
 */
export const DEFAULT_LANG: Lang = 'en'

let lang: Lang = initialLang()

function initialLang(): Lang {
  // Рендерер: язык известен из адреса окна ещё до первой строки его кода.
  if (typeof location !== 'undefined' && typeof location.search === 'string') {
    return parseLang(new URLSearchParams(location.search).get('lang')) ?? DEFAULT_LANG
  }
  return DEFAULT_LANG
}

export function setLang(l: Lang): void {
  lang = l
}

export function getLang(): Lang {
  return lang
}

/** Строка из «ru»/«en» (настройки, адрес) → язык; мусор → null. */
export function parseLang(v: unknown): Lang | null {
  return v === 'ru' || v === 'en' ? v : null
}

const warned = new Set<string>()

/**
 * Русский текст → текст на языке интерфейса. Подстановки — `{имя}`:
 * `t('Слайд {n} из {total}', { n: 3, total: 12 })`. Ключ — всегда строковый
 * литерал целиком, без `${}` внутри: иначе тест не найдёт его в словаре.
 */
export function t(ru: string, vars?: Record<string, string | number | null | undefined>): string {
  let s = ru
  if (lang === 'en') {
    const en = EN[ru]
    if (en !== undefined) s = en
    else if (/[А-Яа-яЁё]/.test(ru) && !warned.has(ru)) { // i18n-ok
      warned.add(ru)
      console.warn(`[i18n] нет перевода: ${ru}`)
    }
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m))
  return s
}
