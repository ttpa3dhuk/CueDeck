import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { app } from 'electron'
import type { SlideMedia } from '../shared/types.js'
import { cachedPdfPathFor } from './pptx-converter.js'

/**
 * PPTX-препроцессор перед конвертацией в PDF. Закрывает две фичи:
 *
 * 2.10 — видео, вшитое в слайд. LibreOffice не рендерит ролики (постер-кадр)
 * и зашивает mp4 внутрь PDF целиком. Поэтому: ролики извлекаются в
 * pptx-cache/<sha1>.media/ + manifest, LibreOffice получает копию без
 * видеофайлов, рендереры накладывают <video> поверх страницы по manifest'у.
 *
 * 2.11 — анимации «по клику» → статичные шаги-страницы. Парсим p:timing:
 * клик-группы главной последовательности (mainSeq). Слайд с N кликами
 * разворачивается в N+1 страниц: на шаге K элементы кликов K+1..N невидимы.
 * Невидимость — не удаление (иначе автофит/раскладка плывёт между шагами), а
 * прозрачность: alpha-0 заливка ранов + <a:buNone/> на буллеты (LibreOffice
 * игнорит alpha в buClr — проверено). Кликер листает шаги как страницы.
 *
 * Первая итерация: entrance-эффекты по абзацам (pRg) и целым фигурам; exit /
 * emphasis / motion path игнорируются (элемент считается видимым с шага 0,
 * если у него нет entrance). Слайд, где есть и видео, и клики, НЕ
 * разворачивается — иначе клик-запуск ролика съедал бы шаги.
 */

/** Расширения, которые Chromium играет нативно — только их несём в manifest. */
const PLAYABLE_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm'])
/** Всё видеообразное стрипаем из копии для LibreOffice (вес PDF). */
const STRIP_EXTS = new Set([...PLAYABLE_EXTS, 'avi', 'wmv', 'mpg', 'mpeg', 'mkv', '3gp', 'asf'])

const MANIFEST_VERSION = 2

const SLIDE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
const SLIDE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'

/** Прозрачная заливка текста: ран есть, место занимает, не виден. */
const HIDE_FILL = '<a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:solidFill>'

interface MediaManifest {
  version: number
  /** Исходник пересобирался (стрип видео и/или шаги) → конвертируем копию. */
  rebuilt: boolean
  slideMedia: SlideMedia[]
}

export interface PreparedPptxMedia {
  slideMedia: SlideMedia[]
  /** Что отдавать LibreOffice: пересобранная копия или оригинал. */
  convertSource: string
  /** convertSource — временный файл, удалить после конверсии. */
  temporary: boolean
}

function cacheDir(): string {
  return join(app.getPath('userData'), 'pptx-cache')
}

/** Папка с извлечёнными роликами данного PPTX (раздаётся через cuedeck-media://). */
export function mediaDirFor(sha1: string): string {
  return join(cacheDir(), `${sha1}.media`)
}

function manifestPathFor(sha1: string): string {
  return join(cacheDir(), `${sha1}.media.json`)
}

function extOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? ''
}

// ── Минимальный zip-reader/writer ────────────────────────────────────────────
// Без зависимостей: читаем central directory, распаковываем нужные записи
// (node:zlib), а копию собираем raw-копированием сжатых данных — сотни МБ не
// пережимаются. Новые/заменённые записи жмутся deflateRawSync. Zip64 не
// поддерживаем (PPTX < 4 ГБ); любая странность — исключение, наверху
// деградируем к конверсии оригинала.

interface ZipEntry {
  name: string
  flags: number
  method: number
  dosTime: number
  dosDate: number
  crc: number
  compSize: number
  uncompSize: number
  localOffset: number
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

// node:zlib.crc32 появился в 20.15 — на системном node его может не быть.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function parseZip(buf: Buffer): ZipEntry[] {
  // EOCD — в последних 64 КБ + 22 байта (комментарий архива).
  const scanFrom = Math.max(0, buf.length - 65_557)
  let eocd = -1
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: EOCD не найден')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 не поддерживается')

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('zip: битый central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const dosTime = buf.readUInt16LE(p + 12)
    const dosDate = buf.readUInt16LE(p + 14)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff)
      throw new Error('zip64 не поддерживается')
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, flags, method, dosTime, dosDate, crc, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Смещение сжатых данных записи (в local header свои длины имени/extra). */
function dataOffsetOf(buf: Buffer, e: ZipEntry): number {
  if (buf.readUInt32LE(e.localOffset) !== LOCAL_SIG) throw new Error(`zip: битый local header ${e.name}`)
  const nameLen = buf.readUInt16LE(e.localOffset + 26)
  const extraLen = buf.readUInt16LE(e.localOffset + 28)
  return e.localOffset + 30 + nameLen + extraLen
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const start = dataOffsetOf(buf, e)
  const raw = buf.subarray(start, start + e.compSize)
  if (e.method === 0) return Buffer.from(raw)
  if (e.method === 8) return inflateRawSync(raw)
  throw new Error(`zip: неподдерживаемый метод сжатия ${e.method} (${e.name})`)
}

interface ZipMods {
  /** Записи, заменяемые пустышками (метод store, 0 байт) — видеофайлы. */
  strip: Set<string>
  /** Записи с новым содержимым (шаг-0 слайды, presentation.xml и т.п.). */
  replace: Map<string, Buffer>
  /** Новые записи (шаг-страницы и их .rels). */
  add: { name: string; data: Buffer }[]
}

/**
 * Пересборка архива: нетронутые записи копируются raw (без пережатия), local
 * headers пишутся заново (без data descriptor и extra), central directory
 * пересобирается с новыми смещениями.
 */
function rebuildZip(buf: Buffer, entries: ZipEntry[], mods: ZipMods): Buffer {
  const parts: Buffer[] = []
  const outEntries: { e: ZipEntry; nameBuf: Buffer; offset: number; data: Buffer | null }[] = []
  let offset = 0

  const baseTime = entries[0]?.dosTime ?? 0
  const baseDate = entries[0]?.dosDate ?? 0x21 // 1980-01-01

  const push = (e: ZipEntry, data: Buffer | null): void => {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_SIG, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(e.flags & 0x0800, 6) // только UTF-8 бит, data descriptor выкидываем
    header.writeUInt16LE(e.method, 8)
    header.writeUInt16LE(e.dosTime, 10)
    header.writeUInt16LE(e.dosDate, 12)
    header.writeUInt32LE(e.crc, 14)
    header.writeUInt32LE(e.compSize, 18)
    header.writeUInt32LE(e.uncompSize, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28) // extra
    parts.push(header, nameBuf)
    if (data && data.length > 0) parts.push(data)
    outEntries.push({ e, nameBuf, offset, data })
    offset += 30 + nameBuf.length + (data?.length ?? 0)
  }

  for (const src of entries) {
    if (mods.strip.has(src.name)) {
      push({ ...src, method: 0, crc: 0, compSize: 0, uncompSize: 0 }, null)
    } else if (mods.replace.has(src.name)) {
      const content = mods.replace.get(src.name)!
      const deflated = deflateRawSync(content)
      push(
        { ...src, method: 8, crc: crc32(content), compSize: deflated.length, uncompSize: content.length },
        deflated,
      )
    } else {
      const start = dataOffsetOf(buf, src)
      push(src, Buffer.from(buf.subarray(start, start + src.compSize)))
    }
  }

  for (const { name, data } of mods.add) {
    const deflated = deflateRawSync(data)
    push(
      {
        name,
        flags: 0x0800,
        method: 8,
        dosTime: baseTime,
        dosDate: baseDate,
        crc: crc32(data),
        compSize: deflated.length,
        uncompSize: data.length,
        localOffset: 0,
      },
      deflated,
    )
  }

  const cdStart = offset
  for (const { e, nameBuf, offset: localOff } of outEntries) {
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(CD_SIG, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(e.flags & 0x0800, 8)
    cd.writeUInt16LE(e.method, 10)
    cd.writeUInt16LE(e.dosTime, 12)
    cd.writeUInt16LE(e.dosDate, 14)
    cd.writeUInt32LE(e.crc, 16)
    cd.writeUInt32LE(e.compSize, 20)
    cd.writeUInt32LE(e.uncompSize, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(localOff, 42)
    parts.push(cd, nameBuf)
    offset += 46 + nameBuf.length
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(outEntries.length, 8)
  eocd.writeUInt16LE(outEntries.length, 10)
  eocd.writeUInt32LE(offset - cdStart, 12)
  eocd.writeUInt32LE(cdStart, 16)
  parts.push(eocd)

  return Buffer.concat(parts)
}

// ── XML-хелперы ──────────────────────────────────────────────────────────────
// OOXML генерируется машиной: без комментариев/CDATA, поэтому сканирование
// тегов регэкспами со счётчиком глубины надёжно.

/** Атрибуты XML-тега; порядок атрибутов в OOXML не гарантирован. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

/** Карта rId → Target из файла .rels. */
function parseRels(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrsOf(m[0])
    if (a.Id && a.Target) map.set(a.Id, a.Target)
  }
  return map
}

/** '../media/media1.mp4' (относительно ppt/slides/) → 'ppt/media/media1.mp4' */
function normalizeSlideTarget(target: string): string {
  return target.replace(/^\.\.\//, 'ppt/')
}

/** 'ppt/slides/slide2.xml' → 'ppt/slides/_rels/slide2.xml.rels' */
function relsPathOf(partPath: string): string {
  const i = partPath.lastIndexOf('/')
  return `${partPath.slice(0, i)}/_rels/${partPath.slice(i + 1)}.rels`
}

/**
 * Первый сбалансированный блок `<tag …>…</tag>` (или самозакрытый `<tag …/>`)
 * начиная с позиции from. Одноимённые вложенные теги учитываются глубиной.
 */
function findBalanced(src: string, tag: string, from = 0): { start: number; end: number } | null {
  const token = new RegExp(`<(/?)${tag.replace(':', '\\:')}(?=[\\s/>])[^>]*>`, 'g')
  token.lastIndex = from
  let depth = 0
  let start = -1
  for (let m = token.exec(src); m; m = token.exec(src)) {
    const closing = m[1] === '/'
    const selfClosing = !closing && m[0].endsWith('/>')
    if (!closing && start < 0) {
      if (selfClosing) return { start: m.index, end: m.index + m[0].length }
      start = m.index
      depth = 1
      continue
    }
    if (start < 0) continue
    if (closing) {
      depth--
      if (depth === 0) return { start, end: m.index + m[0].length }
    } else if (!selfClosing) {
      depth++
    }
  }
  return null
}

/** Все top-level блоки данного тега внутри фрагмента. */
function topLevelBlocks(fragment: string, tag: string): string[] {
  const out: string[] = []
  let pos = 0
  for (;;) {
    const b = findBalanced(fragment, tag, pos)
    if (!b) return out
    out.push(fragment.slice(b.start, b.end))
    pos = b.end
  }
}

// ── Разбор presentation.xml ──────────────────────────────────────────────────

interface Presentation {
  /** Пути слайдов в порядке показа (p:sldIdLst). */
  slidePaths: string[]
  slideW: number
  slideH: number
}

function parsePresentation(text: (name: string) => string | null): Presentation | null {
  const presentation = text('ppt/presentation.xml')
  const presRels = text('ppt/_rels/presentation.xml.rels')
  if (!presentation || !presRels) return null

  const sldSz = presentation.match(/<p:sldSz\b[^>]*>/)
  const szAttrs = sldSz ? attrsOf(sldSz[0]) : {}
  const slideW = Number(szAttrs.cx) || 12_192_000
  const slideH = Number(szAttrs.cy) || 6_858_000

  const sldIdLst = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)
  if (!sldIdLst) return null
  const relMap = parseRels(presRels)
  const slidePaths: string[] = []
  for (const m of sldIdLst[1].matchAll(/r:id="([^"]+)"/g)) {
    const target = relMap.get(m[1])
    if (target) slidePaths.push(target.replace(/^\//, '').replace(/^(?!ppt\/)/, 'ppt/'))
  }
  return { slidePaths, slideW, slideH }
}

// ── 2.10: видео на слайдах ───────────────────────────────────────────────────

interface FoundVideo {
  /** Индекс слайда в порядке показа (0-based). */
  slideIdx: number
  mediaEntry: string // имя записи в zip: ppt/media/media1.mp4
  rect: { x: number; y: number; w: number; h: number }
}

function findSlideVideos(
  pres: Presentation,
  text: (name: string) => string | null,
  hasEntry: (name: string) => boolean,
): FoundVideo[] {
  const found: FoundVideo[] = []
  pres.slidePaths.forEach((slidePath, idx) => {
    const slideXml = text(slidePath)
    if (!slideXml) return
    const relsXml = text(relsPathOf(slidePath))
    const rels = relsXml ? parseRels(relsXml) : new Map<string, string>()

    // Первое видео на слайде (итерация 1); остальные игнорируем.
    for (const pic of topLevelBlocks(slideXml, 'p:pic')) {
      const vid = pic.match(/<a:videoFile\b[^>]*>/)
      if (!vid) continue
      const rId = attrsOf(vid[0])['r:link']
      const target = rId ? rels.get(rId) : undefined
      if (!target) continue
      const mediaEntry = normalizeSlideTarget(target)
      if (!PLAYABLE_EXTS.has(extOf(mediaEntry)) || !hasEntry(mediaEntry)) continue

      // Прямоугольник плейсхолдера; без a:xfrm (наследование из layout) — весь слайд.
      let rect = { x: 0, y: 0, w: 1, h: 1 }
      const xfrm = pic.match(/<a:off\b[^>]*>[\s\S]{0,80}?<a:ext\b[^>]*>/)
      if (xfrm) {
        const off = attrsOf(xfrm[0].match(/<a:off\b[^>]*>/)![0])
        const ext = attrsOf(xfrm[0].match(/<a:ext\b[^>]*>/)![0])
        const x = Number(off.x)
        const y = Number(off.y)
        const cx = Number(ext.cx)
        const cy = Number(ext.cy)
        if ([x, y, cx, cy].every(Number.isFinite) && cx > 0 && cy > 0) {
          rect = {
            x: Math.max(0, Math.min(1, x / pres.slideW)),
            y: Math.max(0, Math.min(1, y / pres.slideH)),
            w: Math.max(0, Math.min(1, cx / pres.slideW)),
            h: Math.max(0, Math.min(1, cy / pres.slideH)),
          }
        }
      }
      found.push({ slideIdx: idx, mediaEntry, rect })
      break
    }
  })
  return found
}

// ── 2.11: клик-анимации → шаги ───────────────────────────────────────────────

interface StepTarget {
  spid: string
  /** Диапазон абзацев (0-based, включительно); whole=true — фигура целиком. */
  whole: boolean
  from: number
  to: number
}

/**
 * Клик-группы главной последовательности слайда. Возвращает по одному массиву
 * целей на клик; клики без entrance-целей (mediacall, exit, emphasis)
 * пропускаются — они не меняют видимый состав слайда.
 */
function parseClickSteps(slideXml: string): StepTarget[][] {
  const timing = slideXml.match(/<p:timing>[\s\S]*?<\/p:timing>/)
  if (!timing) return []

  // mainSeq — p:seq, у чьего cTn nodeType="mainSeq" (интерактивные seq мимо).
  let seqXml: string | null = null
  for (const seq of topLevelBlocks(timing[0], 'p:seq')) {
    if (/nodeType="mainSeq"/.test(seq)) {
      seqXml = seq
      break
    }
  }
  if (!seqXml) return []

  const lst = findBalanced(seqXml, 'p:childTnLst')
  if (!lst) return []
  const inner = seqXml.slice(lst.start + '<p:childTnLst>'.length, lst.end - '</p:childTnLst>'.length)

  const clicks: StepTarget[][] = []
  for (const group of topLevelBlocks(inner, 'p:par')) {
    const targets = entranceTargetsIn(group)
    if (targets.length > 0) clicks.push(targets)
  }
  return clicks
}

/** Entrance-цели клик-группы: скоуп каждого эффекта — от его presetClass до следующего. */
function entranceTargetsIn(groupXml: string): StepTarget[] {
  const marks = [...groupXml.matchAll(/presetClass="(\w+)"/g)]
  const out = new Map<string, StepTarget>()
  for (let i = 0; i < marks.length; i++) {
    if (marks[i][1] !== 'entr') continue
    const scopeEnd = marks[i + 1]?.index ?? groupXml.length
    const scope = groupXml.slice(marks[i].index!, scopeEnd)
    for (const m of scope.matchAll(/<p:spTgt spid="(\d+)"\s*(\/>|>[\s\S]*?<\/p:spTgt>)/g)) {
      const rg = m[2].match(/<p:pRg st="(\d+)" end="(\d+)"/)
      const t: StepTarget = rg
        ? { spid: m[1], whole: false, from: Number(rg[1]), to: Number(rg[2]) }
        : { spid: m[1], whole: true, from: 0, to: 0 }
      out.set(`${t.spid}:${t.whole ? '*' : `${t.from}-${t.to}`}`, t)
    }
  }
  return [...out.values()]
}

const SHAPE_TAGS = ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp']

/** Удалить фигуру по id из spTree (фигуры позиционированы абсолютно — реflow нет). */
function removeShape(xml: string, spid: string): string {
  for (const tag of SHAPE_TAGS) {
    let pos = 0
    for (;;) {
      const b = findBalanced(xml, tag, pos)
      if (!b) break
      const block = xml.slice(b.start, b.end)
      const id = block.match(/<p:cNvPr id="(\d+)"/)
      if (id && id[1] === spid) return xml.slice(0, b.start) + xml.slice(b.end)
      // вложенные фигуры групп ищем, продвигаясь внутрь блока
      pos = b.start + 1
    }
  }
  return xml
}

/**
 * Сделать абзац невидимым, сохранив занимаемое место: alpha-0 заливка всех
 * ранов (существующие заливки внутри rPr вычищаются) + отключение буллета.
 * LibreOffice ≥7.6 честно рендерит прозрачность текста; alpha в buClr —
 * нет, поэтому буллет глушится через <a:buNone/>.
 */
function hideParagraph(p: string): string {
  // самозакрытые rPr: <a:rPr .../> → <a:rPr ...>FILL</a:rPr>
  p = p.replace(/<a:rPr([^>]*)\/>/g, `<a:rPr$1>${HIDE_FILL}</a:rPr>`)
  // открытые rPr: убрать существующие заливки, вставить прозрачную
  p = p.replace(/<a:rPr([^>]*)>([\s\S]*?)<\/a:rPr>/g, (_m, attrs: string, kids: string) => {
    const cleaned = kids
      .replace(/<a:(solidFill|gradFill|pattFill|grpFill)>[\s\S]*?<\/a:\1>/g, '')
      .replace(/<a:noFill\/>/g, '')
    return `<a:rPr${attrs}>${HIDE_FILL}${cleaned}</a:rPr>`
  })
  // раны вовсе без rPr
  p = p.replace(/<a:r>(?!<a:rPr)/g, `<a:r><a:rPr>${HIDE_FILL}</a:rPr>`)
  // буллет: явный маркер долой, buNone внутрь pPr (создать при отсутствии)
  p = p.replace(/<a:bu(Char|AutoNum)\b[^>]*\/>/g, '')
  if (/<a:pPr\b[^>]*\/>/.test(p)) {
    p = p.replace(/<a:pPr\b([^>]*)\/>/, '<a:pPr$1><a:buNone/></a:pPr>')
  } else if (/<a:pPr\b/.test(p)) {
    p = p.replace(/<\/a:pPr>/, '<a:buNone/></a:pPr>')
  } else {
    p = p.replace(/^<a:p>/, '<a:p><a:pPr><a:buNone/></a:pPr>')
  }
  return p
}

/** Скрыть диапазоны абзацев фигуры (индексы — по исходному txBody). */
function hideParagraphs(xml: string, spid: string, indices: Set<number>): string {
  for (const tag of SHAPE_TAGS) {
    let pos = 0
    for (;;) {
      const b = findBalanced(xml, tag, pos)
      if (!b) break
      const block = xml.slice(b.start, b.end)
      const id = block.match(/<p:cNvPr id="(\d+)"/)
      if (!id || id[1] !== spid) {
        pos = b.start + 1
        continue
      }
      const body = findBalanced(block, 'p:txBody')
      if (!body) return xml
      const bodyXml = block.slice(body.start, body.end)
      const paras = topLevelBlocks(bodyXml, 'a:p')
      let newBody = bodyXml
      paras.forEach((para, i) => {
        if (indices.has(i)) newBody = newBody.replace(para, hideParagraph(para))
      })
      const newBlock = block.slice(0, body.start) + newBody + block.slice(body.end)
      return xml.slice(0, b.start) + newBlock + xml.slice(b.end)
    }
  }
  return xml
}

/** XML шага: timing долой, «ещё не появившиеся» цели — невидимы. */
function buildStepXml(slideXml: string, hidden: StepTarget[]): string {
  let xml = slideXml.replace(/<p:timing>[\s\S]*?<\/p:timing>/, '')
  const paraByShape = new Map<string, Set<number>>()
  for (const t of hidden) {
    if (t.whole) {
      xml = removeShape(xml, t.spid)
    } else {
      const set = paraByShape.get(t.spid) ?? new Set<number>()
      for (let i = t.from; i <= t.to; i++) set.add(i)
      paraByShape.set(t.spid, set)
    }
  }
  for (const [spid, set] of paraByShape) xml = hideParagraphs(xml, spid, set)
  return xml
}

// ── Трансформация PPTX целиком ───────────────────────────────────────────────

interface TransformResult {
  /** null — пересборка не нужна (нет ни видео, ни клик-анимаций). */
  zip: Buffer | null
  slideMedia: SlideMedia[]
  videos: FoundVideo[]
}

function transformPptx(data: Buffer, entries: ZipEntry[]): TransformResult {
  const byName = new Map(entries.map((e) => [e.name, e]))
  const textCache = new Map<string, string | null>()
  const text = (name: string): string | null => {
    if (!textCache.has(name)) {
      const e = byName.get(name)
      textCache.set(name, e ? readEntry(data, e).toString('utf8') : null)
    }
    return textCache.get(name)!
  }

  const pres = parsePresentation(text)
  if (!pres) return { zip: null, slideMedia: [], videos: [] }

  const videos = findSlideVideos(pres, text, (n) => byName.has(n))
  const videoSlides = new Set(videos.map((v) => v.slideIdx))

  // Шаги анимаций; слайды с видео не разворачиваем (клик-запуск ролика
  // конфликтовал бы с шагами).
  const stepsBySlide = new Map<number, StepTarget[][]>()
  pres.slidePaths.forEach((slidePath, idx) => {
    if (videoSlides.has(idx)) return
    const slideXml = text(slidePath)
    if (!slideXml) return
    const clicks = parseClickSteps(slideXml)
    if (clicks.length > 0) stepsBySlide.set(idx, clicks)
  })

  const strip = new Set(
    entries
      .filter((e) => e.name.startsWith('ppt/media/') && STRIP_EXTS.has(extOf(e.name)))
      .map((e) => e.name),
  )

  // Номера страниц после разворачивания: слайд idx начинается со страницы firstPage[idx].
  let page = 0
  const firstPage: number[] = []
  pres.slidePaths.forEach((_, idx) => {
    firstPage[idx] = page + 1
    page += 1 + (stepsBySlide.get(idx)?.length ?? 0)
  })

  const slideMedia: SlideMedia[] = videos.map((v) => ({
    slide: firstPage[v.slideIdx],
    rect: v.rect,
    file: v.mediaEntry.split('/').pop()!,
  }))

  if (strip.size === 0 && stepsBySlide.size === 0) return { zip: null, slideMedia, videos }

  const replace = new Map<string, Buffer>()
  const add: { name: string; data: Buffer }[] = []

  if (stepsBySlide.size > 0) {
    let presentation = text('ppt/presentation.xml')!
    let presRels = text('ppt/_rels/presentation.xml.rels')!
    let contentTypes = text('[Content_Types].xml')!
    const relMap = parseRels(presRels)
    const ridBySlidePath = new Map(
      [...relMap].map(([rid, target]) => [
        target.replace(/^\//, '').replace(/^(?!ppt\/)/, 'ppt/'),
        rid,
      ]),
    )
    let maxSldId = Math.max(
      256,
      ...[...presentation.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1])),
    )
    let cdCounter = 0

    for (const [idx, clicks] of stepsBySlide) {
      const slidePath = pres.slidePaths[idx]
      const slideXml = text(slidePath)!
      const relsName = relsPathOf(slidePath)
      const relsEntry = byName.get(relsName)
      const sldIdInserts: string[] = []

      for (let s = 0; s <= clicks.length; s++) {
        const hidden = clicks.slice(s).flat()
        const stepXml = buildStepXml(slideXml, hidden)
        if (s === 0) {
          // Шаг 0 живёт под именем исходного слайда — порядок в sldIdLst сохранён.
          replace.set(slidePath, Buffer.from(stepXml))
          continue
        }
        const stepName = slidePath.replace(/\.xml$/, `_cd${s}.xml`)
        add.push({ name: stepName, data: Buffer.from(stepXml) })
        if (relsEntry) add.push({ name: relsPathOf(stepName), data: readEntry(data, relsEntry) })

        const rid = `rIdCd${++cdCounter}`
        const stepFile = stepName.split('/').pop()!
        presRels = presRels.replace(
          '</Relationships>',
          `<Relationship Id="${rid}" Type="${SLIDE_REL_TYPE}" Target="slides/${stepFile}"/></Relationships>`,
        )
        contentTypes = contentTypes.replace(
          '</Types>',
          `<Override PartName="/${stepName}" ContentType="${SLIDE_CONTENT_TYPE}"/></Types>`,
        )
        sldIdInserts.push(`<p:sldId id="${++maxSldId}" r:id="${rid}"/>`)
      }

      // Шаг-страницы — сразу после исходного слайда в порядке показа.
      const origRid = ridBySlidePath.get(slidePath)
      if (!origRid) throw new Error(`pptx: не найден rId слайда ${slidePath}`)
      const entryRe = new RegExp(`<p:sldId[^>]*r:id="${origRid}"[^>]*/>`)
      if (!entryRe.test(presentation)) throw new Error(`pptx: не найден sldId для ${slidePath}`)
      presentation = presentation.replace(entryRe, (orig) => orig + sldIdInserts.join(''))
    }

    replace.set('ppt/presentation.xml', Buffer.from(presentation))
    replace.set('ppt/_rels/presentation.xml.rels', Buffer.from(presRels))
    replace.set('[Content_Types].xml', Buffer.from(contentTypes))
  }

  return { zip: rebuildZip(data, entries, { strip, replace, add }), slideMedia, videos }
}

// ── Публичный вход ───────────────────────────────────────────────────────────

async function readManifest(sha1: string): Promise<MediaManifest | null> {
  try {
    const raw = await readFile(manifestPathFor(sha1), 'utf8')
    const parsed = JSON.parse(raw) as MediaManifest
    if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.slideMedia)) return null
    return parsed
  } catch {
    return null
  }
}

/** Прогнать трансформацию и положить пересобранную копию в кэш; вернуть её путь. */
async function writeRebuilt(sha1: string, zip: Buffer): Promise<string> {
  const out = join(cacheDir(), `${sha1}.rebuilt.pptx`)
  await mkdir(cacheDir(), { recursive: true })
  await writeFile(out, zip)
  return out
}

/**
 * Подготовка PPTX перед конверсией: manifest + извлечённые ролики в кэше, и
 * выбор источника для LibreOffice (пересобранная копия — без видеофайлов и с
 * развёрнутыми шаг-страницами анимаций). Любая ошибка разбора → деградация к
 * старому поведению (конвертируем оригинал, без оверлеев и шагов).
 */
export async function preparePptxMedia(pptxPath: string, sha1: string): Promise<PreparedPptxMedia> {
  const original: PreparedPptxMedia = { slideMedia: [], convertSource: pptxPath, temporary: false }
  // Парсим только настоящие .pptx: ppt — OLE-бинарь, odp/key — другой XML.
  if (extOf(pptxPath) !== 'pptx') return original

  try {
    const cached = await readManifest(sha1)
    if (cached) {
      if (!cached.rebuilt || existsSync(cachedPdfPathFor(sha1))) {
        return { ...original, slideMedia: cached.slideMedia }
      }
      // PDF из кэша пропал — пересобираем копию заново.
      const data = await readFile(pptxPath)
      const t = transformPptx(data, parseZip(data))
      if (!t.zip) return { ...original, slideMedia: cached.slideMedia }
      return {
        slideMedia: t.slideMedia,
        convertSource: await writeRebuilt(sha1, t.zip),
        temporary: true,
      }
    }

    const data = await readFile(pptxPath)
    const entries = parseZip(data)
    const t = transformPptx(data, entries)

    // Извлечь ролики (для оверлеев), даже если пересборка не нужна.
    if (t.videos.length > 0) {
      const dir = mediaDirFor(sha1)
      await mkdir(dir, { recursive: true })
      const byName = new Map(entries.map((e) => [e.name, e]))
      for (const v of t.videos) {
        const file = v.mediaEntry.split('/').pop()!
        await writeFile(join(dir, file), readEntry(data, byName.get(v.mediaEntry)!))
      }
    }

    await mkdir(cacheDir(), { recursive: true })
    const manifest: MediaManifest = {
      version: MANIFEST_VERSION,
      rebuilt: t.zip !== null,
      slideMedia: t.slideMedia,
    }
    await writeFile(manifestPathFor(sha1), JSON.stringify(manifest))

    if (!t.zip) return { ...original, slideMedia: t.slideMedia }

    // Старый кэшированный PDF (до пересборки) — пересоздать.
    await rm(cachedPdfPathFor(sha1), { force: true }).catch(() => undefined)
    return {
      slideMedia: t.slideMedia,
      convertSource: await writeRebuilt(sha1, t.zip),
      temporary: true,
    }
  } catch (err) {
    console.warn('[pptx-media] разбор не удался, конвертирую оригинал:', (err as Error).message)
    return original
  }
}
