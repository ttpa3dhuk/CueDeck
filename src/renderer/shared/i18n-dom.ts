import { getLang, t } from '../../shared/i18n'
import { EN_HTML } from '../../shared/i18n-en'

/**
 * Перевод статичного HTML окна при загрузке (i18n.ts). Русский текст в
 * index.html остаётся источником: здесь каждый текстовый узел и подсказка
 * (title, placeholder, aria-label) ищутся в словаре целиком.
 *
 * - `data-i18n-html="имя"` — блок с разметкой внутри, переводится целиком
 *   по имени (EN_HTML).
 * - `translate="no"` — не трогать (названия языков в «Настройках»).
 *
 * Звать один раз, до того как код окна начнёт что-то рисовать в DOM: то,
 * что вставлено потом, переводится своим t() в месте вставки.
 */
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'] as const
const CYR = /[А-Яа-яЁё]/ // i18n-ok

/** Пробелы и переносы строк из вёрстки → один пробел: так ключ совпадает со словарём. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function translateDom(root: Document = document): void {
  root.documentElement.lang = getLang()
  if (getLang() === 'ru') return

  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
    const html = EN_HTML[el.dataset.i18nHtml ?? '']
    if (html !== undefined) el.innerHTML = html
  }

  const skip = (n: Node): boolean =>
    Boolean(n.parentElement?.closest('[translate="no"], [data-i18n-html], script, style'))

  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue ?? ''
    if (!CYR.test(raw) || skip(n)) continue
    const lead = /^\s*/.exec(raw)![0]
    const trail = /\s*$/.exec(raw)![0]
    n.nodeValue = lead + t(normalizeText(raw)) + trail
  }

  for (const el of root.body.querySelectorAll<HTMLElement>('*')) {
    if (el.closest('[translate="no"]')) continue
    for (const a of ATTRS) {
      const v = el.getAttribute(a)
      if (v && CYR.test(v)) el.setAttribute(a, t(normalizeText(v)))
    }
  }
}
