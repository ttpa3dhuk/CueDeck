/**
 * Проверка шрифтов PPTX. В файле лежат только названия шрифтов, самих шрифтов
 * там обычно нет. Нет шрифта на машине — LibreOffice молча берёт другой, и
 * вёрстка слайда уезжает (переносы строк, автофит). Оператор должен узнать об
 * этом на подготовке, а не на сцене.
 *
 * Сравниваем две вещи: что просит презентация (XML) и что реально попало в PDF
 * (имена шрифтов в нём). Список установленных шрифтов не перебираем: так нет
 * кода под каждую ОС, и сверка идёт с тем, что увидел сам LibreOffice.
 *
 * Чистые функции, без Electron и без чтения файлов — покрыто tests/pptx-fonts.test.ts.
 */

/** Шрифты-символы: подмена на OpenSymbol не двигает вёрстку, шуметь не надо. */
const SYMBOL_FONTS = /^(symbol|wingdings\b|webdings|marlett|zapf)/i

/** Метрически совместимые замены, которые LibreOffice везёт с собой: ширина букв та же. */
const METRIC_ALIASES: Array<[string, string]> = [
  ['calibri', 'carlito'],
  ['cambria', 'caladea'],
  ['arialnarrow', 'liberationsansnarrow'],
  ['arial', 'liberationsans'],
  ['helvetica', 'liberationsans'],
  ['timesnewroman', 'liberationserif'],
  ['times', 'liberationserif'],
  ['couriernew', 'liberationmono'],
]

/** Хвосты имён PostScript и начертаний, которые не меняют семейство. */
const STYLE_TAIL = /(bolditalic|boldoblique|bold|italic|oblique|regular|roman|psmt|mt|ps)$/

/** «Arial MT», «ArialMT», «Arial-BoldMT» → «arial»; «Times New Roman PS» → «timesnewroman». */
export function normalizeFontName(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9а-яё]/g, '') // i18n-ok: кириллица в названии шрифта
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(STYLE_TAIL, '')
  }
  return s
}

/** Названия шрифтов из XML части PPTX (`<a:latin typeface="…"/>`). */
function latinFaces(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<a:latin\b[^>]*\btypeface="([^"]*)"/g)) out.push(decodeAttr(m[1]))
  return out
}

function decodeAttr(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/** Шрифты темы презентации: заголовочный (+mj-lt) и основной (+mn-lt). */
function themeFonts(themeXml: string): { major: string | null; minor: string | null } {
  const pick = (tag: string): string | null => {
    const block = themeXml.match(new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`))
    return (block && latinFaces(block[1])[0]) || null
  }
  return { major: pick('majorFont'), minor: pick('minorFont') }
}

/** Первый шрифт блока стилей мастера (titleStyle / bodyStyle). */
function masterStyleFace(masterXml: string, tag: string): string | null {
  const block = masterXml.match(new RegExp(`<p:${tag}>([\\s\\S]*?)</p:${tag}>`))
  return (block && latinFaces(block[1])[0]) || null
}

/**
 * Шрифты, которыми набран видимый текст слайдов. Не всё, что написано в файле:
 * тема и мастера перечисляют шрифты, которыми никто не пользуется (в шаблоне
 * Calibri, а весь текст Arial), и тревога о них была бы ложной.
 *
 * Берём каждый ран с текстом: явный шрифт, а если его нет — унаследованный
 * (заголовок → шрифт заголовков мастера или темы, остальное → основной).
 * Диаграммы (ppt/charts) и схемы SmartArt (ppt/diagrams) читаем отдельно.
 * Макеты не разбираем: переопределение шрифта на уровне макета бывает редко.
 * Только латиница (`a:latin`): для иероглифов и сложных письменностей
 * LibreOffice подбирает шрифт сам.
 * @param names имена всех частей архива
 * @param text  содержимое части (null — нет такой)
 * @param slidePaths части видимых слайдов (скрытых в PDF нет)
 */
export function requestedFonts(
  names: string[],
  text: (name: string) => string | null,
  slidePaths: string[],
): string[] {
  // Тема и стили первого мастера (в типичной презентации он один).
  let theme: { major: string | null; minor: string | null } = { major: null, minor: null }
  let masterTitle: string | null = null
  let masterBody: string | null = null
  const masterPath = names.find((n) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(n))
  if (masterPath) {
    const masterXml = text(masterPath) ?? ''
    masterTitle = masterStyleFace(masterXml, 'titleStyle')
    masterBody = masterStyleFace(masterXml, 'bodyStyle')
    const relsXml = text(masterPath.replace('slideMasters/', 'slideMasters/_rels/') + '.rels') ?? ''
    const target = relsXml.match(/Target="([^"]*theme[^"]*\.xml)"/)
    if (target) {
      const themeXml = text('ppt/' + target[1].replace(/^(\.\.\/)+/, '').replace(/^\/?ppt\//, ''))
      if (themeXml) theme = themeFonts(themeXml)
    }
  }

  const resolve = (face: string | null, title: boolean): string | null => {
    const f = face?.trim() ?? ''
    if (f === '+mj-lt') return theme.major
    if (f === '+mn-lt') return theme.minor
    if (f && !f.startsWith('+')) return f
    // Явного шрифта нет: берём из стиля мастера, а там чаще ссылка на тему.
    const inherited = title ? masterTitle : masterBody
    if (inherited && !inherited.startsWith('+')) return inherited
    return title ? theme.major : theme.minor
  }

  const found = new Set<string>()
  const addRuns = (xml: string, title: boolean): void => {
    for (const m of xml.matchAll(/<a:(?:r|fld)\b[^>]*>([\s\S]*?)<\/a:(?:r|fld)>/g)) {
      const run = m[1]
      const t = run.match(/<a:t>([\s\S]*?)<\/a:t>/)
      if (!t || t[1].trim() === '') continue
      const face = resolve(latinFaces(run)[0] ?? null, title)
      if (face && !SYMBOL_FONTS.test(face)) found.add(face)
    }
  }

  for (const p of slidePaths) {
    const xml = text(p)
    if (!xml) continue
    // Фигуры по одной: заголовок наследует шрифт заголовков, остальное — основной.
    const rest = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (block) => {
      addRuns(block, /<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/.test(block))
      return ''
    })
    addRuns(rest, false) // таблицы и группы вне p:sp
  }

  // Диаграммы и схемы SmartArt лежат в своих частях архива, не в слайде. Шрифт
  // там обычно задан явно и именно там, где он нужен, поэтому берём его целиком.
  for (const n of names) {
    const xml = /^ppt\/(charts\/chart|diagrams\/drawing)[^/]*\.xml$/.test(n) ? text(n) : null
    if (!xml) continue
    for (const face of latinFaces(xml)) {
      const f = resolve(face, false)
      if (f && !SYMBOL_FONTS.test(f)) found.add(f)
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b))
}

/** Шрифты, попавшие в PDF: `/BaseFont /ABCDEF+ArialMT` без префикса подмножества. */
export function usedPdfFonts(pdf: Buffer): string[] {
  const out = new Set<string>()
  const src = pdf.toString('latin1')
  for (const m of src.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)) {
    out.add(m[1].replace(/^[A-Z]{6}\+/, ''))
  }
  return [...out]
}

/**
 * Хвосты, которые в PostScript-имени самого шрифта означают обычное начертание
 * («Futura-Medium», «Avenir-Book» — это и есть Futura и Avenir).
 */
const PLAIN_TAIL = /^(book|medium)$/
/**
 * «Aptos Display» просили, а в PDF есть «Aptos»: оптический вариант не
 * понадобился (его кириллицу, например, рисует другой шрифт), это не подмена.
 * Обратное — просили «Aptos», а есть только «AptosDisplay» — подмена: основного
 * начертания нет, и LibreOffice взял соседнее.
 */
const OPTICAL_TAIL = /^(display|text)$/

/** Шрифт просили, а в PDF его нет и совместимой замены тоже нет. */
function isSubstituted(requested: string, used: string[]): boolean {
  const r = normalizeFontName(requested)
  if (!r) return false
  const norm = used.map(normalizeFontName)
  if (norm.some((u) => u === r || (u.startsWith(r) && PLAIN_TAIL.test(u.slice(r.length))))) return false
  if (norm.some((u) => u.length >= 4 && r.startsWith(u) && OPTICAL_TAIL.test(r.slice(u.length)))) return false
  for (const [from, to] of METRIC_ALIASES) {
    if (r.startsWith(normalizeFontName(from)) && norm.some((u) => u.startsWith(normalizeFontName(to)))) return false
  }
  return true
}

/**
 * Шрифты из презентации, вместо которых в PDF подставлены другие.
 * Нет шрифтов в PDF вовсе (картинки, нераспознанный формат) — проверять нечем,
 * ничего не сообщаем: ложная тревога хуже молчания.
 */
export function substitutedFonts(requested: string[], pdf: Buffer): string[] {
  const used = usedPdfFonts(pdf)
  if (used.length === 0) return []
  return requested.filter((f) => isSubstituted(f, used))
}
