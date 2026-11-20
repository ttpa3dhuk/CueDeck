import type { SlideBuildAnimation } from '../shared/types.js'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { join, posix } from 'node:path'
import { isCurrentPptxManifest, PPTX_MANIFEST_VERSION } from '../shared/presentation-preparation.js'
import type { SlideAudioCue, SlideForegroundActor, SlideForegroundMotion, SlideInteractiveLayer, SlideMedia, SlideTrigger, SlideVideoLink } from '../shared/types.js'
import { requestedFonts } from './pptx-fonts.js'
import { isAnimatedGif } from '../shared/gif.js'
import { pptxSlideTransition } from '../shared/pptx-transition.js'

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
 *
 * 2.23 — заметки докладчика (ppt/notesSlides, плейсхолдер type="body") по
 * страницам PDF: слайд с шагами отдаёт заметку каждому шагу. Скрытые слайды
 * (show="0") LibreOffice в PDF не выводит (проверено) — страниц у них нет,
 * ни видео, ни шагов, ни заметок.
 */

/** Расширения, которые Chromium играет нативно — только их несём в manifest. */
const PLAYABLE_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm'])
/** Всё видеообразное стрипаем из копии для LibreOffice (вес PDF). */
const STRIP_EXTS = new Set([...PLAYABLE_EXTS, 'avi', 'wmv', 'mpg', 'mpeg', 'mkv', '3gp', 'asf'])

const MANIFEST_VERSION = PPTX_MANIFEST_VERSION
/** Older PDFs remain reusable only when no changed chart/field/GIF pixels are found. */
const COMPATIBLE_PDF_VERSIONS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

const SLIDE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
const SLIDE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const NOTES_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'

/** Прозрачная заливка текста: ран есть, место занимает, не виден. */
const HIDE_FILL = '<a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:solidFill>'

interface MediaManifest {
  version: number
  renderer?: 'libreoffice' | 'powerpoint'
  /** Исходник пересобирался (стрип видео и/или шаги) → конвертируем копию. */
  rebuilt: boolean
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, import('../shared/pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('../shared/types.js').SlideVideoLink[]>
  slideKiosk?: boolean
  slideNumbering?: import('../shared/slide-numbering').SlideNumbering
  /** Заметки докладчика: номер страницы PDF (1-based) → текст. */
  pageNotes: Record<number, string>
  /** Шрифты, которые просит презентация (проверка подмены — pptx-fonts.ts). */
  fonts: string[]
}

export interface PreparedPptxMedia {
  nativeFrameSources?: Array<{ file: string; sourcePath: string }>
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, import('../shared/pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('../shared/types.js').SlideVideoLink[]>
  slideKiosk?: boolean
  slideNumbering?: import('../shared/slide-numbering').SlideNumbering
  /** Заметки докладчика из PPTX по страницам PDF (1-based). */
  pageNotes: Record<number, string>
  /** Шрифты, которые просит презентация. */
  fonts: string[]
  /** Что отдавать LibreOffice: пересобранная копия или оригинал. */
  convertSource: string
  /** convertSource — временный файл, удалить после конверсии. */
  temporary: boolean
}

/**
 * Куда писать артефакты и откуда читать manifest. В main это локальный кэш
 * (с учётом project-cache), в utilityProcess — приватный stage текущего job.
 * Модуль не знает про Electron: пути передаются снаружи.
 */
export interface PptxMediaRoots {
  /** Пересобранная копия и извлечённые ролики нового разбора. */
  writeDir: string
  /** Где искать manifest/media (может быть project-cache или versioned-root). */
  readDir(sha1: string): string
  /** Готовый PDF для этого sha1, если он уже есть. */
  pdfPath(sha1: string): string
}

type PptxMediaRootsResolver = () => PptxMediaRoots
let configuredRoots: PptxMediaRootsResolver | null = null
let fallbackRoots: PptxMediaRoots | null = null

/**
 * Main регистрирует резолвер один раз (project-cache). Worker передаёт roots
 * аргументом и сюда не попадает; импорт модуля сам по себе Electron не тянет.
 */
export function configurePptxMediaRoots(resolver: PptxMediaRootsResolver): void {
  configuredRoots = resolver
}

function currentRoots(): PptxMediaRoots | null {
  return configuredRoots ? configuredRoots() : fallbackRoots
}

/** Ленивый резолвер для main/старых тестов: динамический импорт, не статический. */
async function resolveRoots(roots?: PptxMediaRoots): Promise<PptxMediaRoots> {
  if (roots) return roots
  const ready = currentRoots()
  if (ready) return ready
  const pc = await import('./project-cache.js') as typeof import('./project-cache.js')
  const pdfPath: (sha1: string) => string = (sha1) => {
    const root = pc.pptxReadCacheDir(sha1)
    return pc.pdfCachePath(root, sha1) ?? join(root, `${sha1}.pdf`)
  }
  fallbackRoots = {
    writeDir: pc.localPptxCacheDir(),
    readDir: (sha1) => pc.pptxReadCacheDir(sha1),
    pdfPath,
  }
  return fallbackRoots
}

/** Папка с извлечёнными роликами данного PPTX (раздаётся через cuedeck-media://). */
export function mediaDirFor(sha1: string): string {
  const roots = currentRoots()
  if (!roots) throw new Error('pptx-media: roots are not configured')
  return join(roots.readDir(sha1), `${sha1}.media`)
}

function manifestPathFor(sha1: string, roots: PptxMediaRoots): string {
  return join(roots.readDir(sha1), `${sha1}.media.json`)
}

function extOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? ''
}

/** ZIP paths use '/', but extracted names must also be safe on Windows. */
function mediaFileName(entry: string): string {
  const file = entry.split('/').pop()!
  // Backslashes can escape the media directory; ':' can address an NTFS stream.
  // Validate before extraction, keeping ordinary names and the cache format intact.
  if (!file || file === '.' || file === '..' || /[\\:\0]/.test(file)) {
    throw new Error('pptx: unsafe embedded media filename')
  }
  return file
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
      push(src, buf.subarray(start, start + src.compSize))
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

/** Карта rId → Target из файла .rels (с фильтром по Type — только нужные связи). */
function parseRels(xml: string, type?: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrsOf(m[0])
    if (type && a.Type !== type) continue
    if (a.Id && a.Target) map.set(a.Id, a.Target)
  }
  return map
}

/** Текст XML без сущностей: &amp; &lt; &#1234; &#x41; … */
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : Number(k.slice(1))
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
}

/** Скрытый слайд (show="0" на корневом p:sld) — в показе и в PDF его нет. */
function isHiddenSlide(slideXml: string): boolean {
  const root = slideXml.match(/<p:sld\b[^>]*>/)
  return root ? attrsOf(root[0]).show === '0' : false
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

/** Use Office's own raster preview when its newer chart cannot be rendered faithfully. */
function preferChartPreviews(xml: string, imageExists: (rid: string) => boolean): string {
  for (const alternate of topLevelBlocks(xml, 'mc:AlternateContent')) {
    const choices = topLevelBlocks(alternate, 'mc:Choice')
    if (!choices.some(choice => /<a:graphicData\b[^>]*\buri="http:\/\/schemas\.microsoft\.com\/office\/drawing\/2014\/chartex"/.test(choice))) continue
    const fallback = topLevelBlocks(alternate, 'mc:Fallback')[0]
    if (!fallback) continue
    const inner = fallback.replace(/^<mc:Fallback\b[^>]*>/, '').replace(/<\/mc:Fallback>$/, '')
    const pictures = topLevelBlocks(inner, 'p:pic')
    if (pictures.length !== 1 || inner.replace(pictures[0], '').trim()) continue
    const blip = pictures[0].match(/<a:blip\b[^>]*>/)?.[0]
    if (!blip || !imageExists(attrsOf(blip)['r:embed'])) continue
    // The wrapper may own namespace bindings used inside the fallback picture.
    const namespaces = new Map<string, string>()
    for (const opening of [alternate.match(/^<[^>]*>/)?.[0], fallback.match(/^<[^>]*>/)?.[0]]) {
      for (const match of (opening ?? '').matchAll(/\s(xmlns(?::[\w.-]+)?)="([^"]*)"/g)) namespaces.set(match[1], match[2])
    }
    let picture = pictures[0]
    const opening = picture.match(/^<[^>]*>/)![0]
    const bindings = [...namespaces].filter(([key]) => !(key in attrsOf(opening)))
      .map(([key, value]) => ` ${key}="${value}"`).join('')
    picture = picture.replace(/^<p:pic\b/, `<p:pic${bindings}`)
    xml = xml.replace(alternate, picture)
  }
  return xml
}

/** Build pages keep the authored slide number, rather than LibreOffice's new page index. */
function freezeSlideNumbers(xml: string): string {
  return xml.replace(/<a:fld\b[^>]*>[\s\S]*?<\/a:fld>/g, field => {
    if (attrsOf(field.match(/^<[^>]*>/)![0]).type !== 'slidenum') return field
    const text = topLevelBlocks(field, 'a:t')[0]
    if (!text) return field
    return `<a:r>${topLevelBlocks(field, 'a:rPr')[0] ?? ''}${text}</a:r>`
  })
}

// ── Разбор presentation.xml ──────────────────────────────────────────────────

interface Presentation {
  /** Пути слайдов в порядке показа (p:sldIdLst). */
  slidePaths: string[]
  /** Индексы скрытых слайдов — страниц в PDF у них нет. */
  hidden: Set<number>
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
  const hidden = new Set<number>()
  slidePaths.forEach((path, idx) => {
    const xml = text(path)
    if (xml && isHiddenSlide(xml)) hidden.add(idx)
  })
  return { slidePaths, hidden, slideW, slideH }
}

// ── 2.10: видео на слайдах ───────────────────────────────────────────────────

/** Recognize only immediate slide-entry playback; unknown/delayed timings stay manual. */
export function parseVideoPlayback(slideXml: string, shapeId: string): { autoPlay: boolean; loop: boolean } {
  const timing = slideXml.match(/<p:timing\b[^>]*>[\s\S]*?<\/p:timing>/)?.[0] ?? ''
  const targetsShape = (xml: string): boolean => [...xml.matchAll(/<p:spTgt\b[^>]*>/g)]
    .some((m) => attrsOf(m[0]).spid === shapeId)
  let loop = false
  let autoPlay = false
  // Direct media nodes are siblings of sequences, never interactive click handlers.
  let direct = timing
  for (const seq of topLevelBlocks(timing, 'p:seq')) direct = direct.replace(seq, '')
  for (const video of topLevelBlocks(direct, 'p:video')) {
    if (!targetsShape(video)) continue
    const node = video.match(/<p:cTn\b[^>]*>/)?.[0]
    if (node && attrsOf(node).repeatCount === 'indefinite') loop = true
    const conditions = video.match(/<p:stCondLst>[\s\S]*?<\/p:stCondLst>/)?.[0]
    if (conditions) {
      const conds = [...conditions.matchAll(/<p:cond\b[^>]*>/g)].map((m) => attrsOf(m[0]))
      if (conds.length === 1 && conds[0].delay === '0' && !conds[0].evt) autoPlay = true
    }
  }
  for (const seq of topLevelBlocks(timing, 'p:seq')) {
    const seqNode = seq.match(/<p:cTn\b[^>]*>/)?.[0]
    if (!seqNode || attrsOf(seqNode).nodeType !== 'mainSeq') continue
    const mainId = attrsOf(seqNode).id
    const lst = findBalanced(seq, 'p:childTnLst')
    if (!lst || !mainId) continue
    const inner = seq.slice(lst.start + '<p:childTnLst>'.length, lst.end - '</p:childTnLst>'.length)
    const firstGroup = topLevelBlocks(inner, 'p:par')[0]
    if (!firstGroup) continue
    const firstChild = firstGroup.indexOf('<p:childTnLst>')
    const trigger = firstGroup.slice(0, firstChild < 0 ? firstGroup.length : firstChild)
    const startsAtEntry = topLevelBlocks(trigger, 'p:cond').some((cond) => {
      const attrs = attrsOf(cond.match(/<p:cond\b[^>]*>/)![0])
      const tn = cond.match(/<p:tn\b[^>]*>/)?.[0]
      return attrs.evt === 'onBegin' && attrs.delay === '0' && tn && attrsOf(tn).val === mainId
    })
    if (!startsAtEntry) continue
    for (const cmd of topLevelBlocks(firstGroup, 'p:cmd')) {
      const attrs = attrsOf(cmd.match(/<p:cmd\b[^>]*>/)![0])
      if (!/^playFrom\(0(?:\.0+)?\)$/.test(attrs.cmd ?? '') || !targetsShape(cmd)) continue
      const cmdAt = firstGroup.indexOf(cmd)
      let safe = true
      let effect = false
      // Every timing ancestor of the command must start immediately.
      for (const mark of firstGroup.matchAll(/<p:cTn\b[^>]*>/g)) {
        const block = findBalanced(firstGroup, 'p:cTn', mark.index)
        if (!block || block.start !== mark.index || block.end <= cmdAt || block.start >= cmdAt) continue
        const attrs = attrsOf(mark[0])
        if (attrs.nodeType) {
          if (!['withEffect', 'afterEffect'].includes(attrs.nodeType)) safe = false
          else effect = true
        }
        if (block.start === firstGroup.indexOf('<p:cTn')) continue // checked entry trigger above
        const body = firstGroup.slice(block.start, block.end)
        const head = body.split('<p:childTnLst>')[0]
        for (const cond of head.matchAll(/<p:cond\b[^>]*>/g)) {
          const c = attrsOf(cond[0])
          if (c.delay !== '0' || c.evt) safe = false
        }
      }
      // An afterEffect following another effect may wait for its duration.
      const effectMarks = [...firstGroup.slice(0, cmdAt).matchAll(/nodeType="(withEffect|afterEffect|clickEffect)"/g)]
      if (effectMarks.some((m) => m[1] === 'afterEffect') && effectMarks.length > 1) safe = false
      if (safe && effect) autoPlay = true
    }
  }
  return { autoPlay, loop }
}

function mediaTiming(slideXml: string, tag: 'p:audio' | 'p:video', shapeId: string) {
  const timing = findBalanced(slideXml, 'p:timing')
  if (!timing) return undefined
  const node = topLevelBlocks(slideXml.slice(timing.start, timing.end), tag)
    .find(block => [...block.matchAll(/<p:spTgt\b[^>]*>/g)].some(target => attrsOf(target[0]).spid === shapeId))
  if (!node) return undefined
  const volume = Number(attrsOf(node.match(/<p:cMediaNode\b[^>]*>/)?.[0] ?? '').vol ?? 100_000)
  return {
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100_000)) : 1,
    loop: attrsOf(node.match(/<p:cTn\b[^>]*>/)?.[0] ?? '').repeatCount === 'indefinite',
  }
}

function interactiveSequences(slideXml: string): Array<{ shape: string; sequence: string; restart: SlideTrigger['restart'] }> {
  const timing = findBalanced(slideXml, 'p:timing')
  if (!timing) return []
  return topLevelBlocks(slideXml.slice(timing.start, timing.end), 'p:seq').flatMap(sequence => {
    const node = attrsOf(sequence.match(/<p:cTn\b[^>]*>/)?.[0] ?? '')
    if (node.nodeType !== 'interactiveSeq') return []
    const head = sequence.split('<p:childTnLst>')[0]
    const conditions = topLevelBlocks(head, 'p:stCondLst').flatMap(list => topLevelBlocks(list, 'p:cond'))
    return conditions.flatMap(condition => {
      const evt = attrsOf(condition.match(/^<p:cond\b[^>]*>/)?.[0] ?? '').evt
      const shape = attrsOf(condition.match(/<p:spTgt\b[^>]*>/)?.[0] ?? '').spid
      const restart = node.restart === 'whenNotActive' || node.restart === 'never' ? node.restart : 'always'
      return evt === 'onClick' && /^\d+$/.test(shape) ? [{ shape, sequence, restart }] : []
    })
  })
}

function playCommands(sequence: string, entry = false): Array<{ shape: string; delayMs: number }> {
  return timedEffects(sequence, entry).flatMap(({ xml, startMs }) => topLevelBlocks(xml, 'p:cmd').flatMap(command => {
    const { cmd } = attrsOf(command.match(/^<p:cmd\b[^>]*>/)?.[0] ?? '')
    const shape = attrsOf(command.match(/<p:spTgt\b[^>]*>/)?.[0] ?? '').spid
    const delay = Number(attrsOf(command.match(/<p:stCondLst>\s*<p:cond\b[^>]*>/)?.[0] ?? '').delay ?? 0)
    return /^playFrom\(0(?:\.0+)?\)$/.test(cmd) && shape && Number.isFinite(delay) && delay >= 0 && startMs + delay <= 60_000
      ? [{ shape, delayMs: startMs + delay }] : []
  }))
}

function inlineAudioCues(slideXml: string, shapes: Map<string, string>, rels: Map<string, string>, menuTrigger?: string) {
  const enter = playCommands(mainSequence(slideXml), true)
  const clicks = interactiveSequences(slideXml).map(({ shape, sequence }) => ({ shape, commands: playCommands(sequence) }))
  const cues: Array<{ mediaEntry: string; cue: SlideAudioCue }> = []
  for (const [shapeId, shape] of shapes) {
    const sound = shape.match(/<a:audioFile\b[^>]*>/)?.[0]
    const target = sound && rels.get(attrsOf(sound)['r:link'])
    if (!target) continue
    const mediaEntry = normalizeSlideTarget(target)
    if (extOf(mediaEntry) !== 'mp3') continue
    const settings = mediaTiming(slideXml, 'p:audio', shapeId) ?? { volume: 1, loop: false }
    const file = mediaFileName(mediaEntry)
    for (const command of enter) if (command.shape === shapeId) {
      cues.push({ mediaEntry, cue: { ...settings, file, trigger: 'enter', delayMs: command.delayMs } })
    }
    for (const click of clicks) for (const command of click.commands) if (command.shape === shapeId) {
      const trigger = click.shape === menuTrigger ? { trigger: 'menu' as const } : { trigger: 'click' as const, shape: click.shape }
      cues.push({ mediaEntry, cue: { ...settings, file, ...trigger, delayMs: command.delayMs } })
    }
  }
  return { cues, clicks }
}

function slideAudioShapes(contents: string): Map<string, string> {
  const ungrouped = topLevelBlocks(contents, 'p:grpSp').reduce((out, group) => out.replace(group, ''), contents)
  return new Map(SHAPE_TAGS.flatMap(tag => topLevelBlocks(ungrouped, tag)).map(shape =>
    [attrsOf(shape.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? '').id, shape]))
}

interface FoundVideo {
  kind?: 'gif'
  shapeId?: string
  /** Индекс слайда в порядке показа (0-based). */
  slideIdx: number
  mediaEntry: string // имя записи в zip: ppt/media/media1.mp4
  rect: { x: number; y: number; w: number; h: number }
  crop?: SlideMedia['crop']
  autoPlay: boolean
  loop: boolean
}

function findSlideGifs(pres: Presentation, text: (name: string) => string | null, data: Buffer, entries: Map<string, ZipEntry>): FoundVideo[] {
  const found: FoundVideo[] = []
  pres.slidePaths.forEach((path, slideIdx) => {
    if (pres.hidden.has(slideIdx)) return
    const xml = text(path) ?? ''
    const rels = parseRels(text(relsPathOf(path)) ?? '')
    // Group coordinates/rotated shapes need their own transform, retain the PDF fallback.
    let plain = xml
    for (const group of topLevelBlocks(xml, 'p:grpSp')) plain = plain.replace(group, '')
    for (const pic of topLevelBlocks(plain, 'p:pic')) {
      const blip = pic.match(/<a:blip\b[^>]*>/)?.[0]
      const target = blip && rels.get(attrsOf(blip)['r:embed'])
      if (!target) continue
      const mediaEntry = normalizeSlideTarget(target)
      const entry = entries.get(mediaEntry)
      if (extOf(mediaEntry) !== 'gif' || !entry || !isAnimatedGif(readEntry(data, entry))) continue
      const shape = pic.match(/<p:cNvPr\b[^>]*>/)?.[0]
      const transform = topLevelBlocks(pic, 'a:xfrm')[0]
      const transformAttrs = transform ? attrsOf(transform.match(/^<[^>]*>/)![0]) : {}
      if (!shape || !transform || Number(transformAttrs.rot ?? 0) || ['1', 'true'].includes(transformAttrs.flipH) || ['1', 'true'].includes(transformAttrs.flipV)) continue
      // a:ext also occurs in metadata extension lists before the real geometry.
      const off = transform.match(/<a:off\b[^>]*>/)?.[0], ext = transform.match(/<a:ext\b[^>]*>/)?.[0]
      if (!off || !ext) continue
      const x = Number(attrsOf(off).x), y = Number(attrsOf(off).y)
      const w = Number(attrsOf(ext).cx), h = Number(attrsOf(ext).cy)
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue
      const srcRect = pic.match(/<a:srcRect\b[^>]*>/)?.[0]
      const c = srcRect ? attrsOf(srcRect) : {}
      const [left, top, right, bottom] = ['l', 't', 'r', 'b'].map(key => Number(c[key] ?? 0) / 100_000)
      if (![left, top, right, bottom].every(Number.isFinite) || left + right >= 1 || top + bottom >= 1) continue
      // A single PDF backdrop cannot reproduce static foreground objects above
      // a live image. Retain the original picture rather than cover that content.
      const after = xml.slice(xml.indexOf(pic) + pic.length)
      const foreground = ['p:sp', 'p:pic', 'p:graphicFrame', 'p:cxnSp', 'p:grpSp'].flatMap(tag => topLevelBlocks(after, tag))
      if (foreground.some(block => {
        const geometry = topLevelBlocks(block, 'a:xfrm')[0] ?? topLevelBlocks(block, 'p:xfrm')[0] ?? ''
        const off = geometry.match(/<a:off\b[^>]*>/)?.[0], ext = geometry.match(/<a:ext\b[^>]*>/)?.[0]
        if (!off || !ext) return true
        const a = attrsOf(off), b = attrsOf(ext)
        return Number(a.x) < x + w && Number(a.y) < y + h && Number(a.x) + Number(b.cx) > x && Number(a.y) + Number(b.cy) > y
      })) continue
      found.push({ kind: 'gif', shapeId: attrsOf(shape).id, slideIdx, mediaEntry,
        rect: { x: x / pres.slideW, y: y / pres.slideH, w: w / pres.slideW, h: h / pres.slideH },
        crop: { left, top, right, bottom }, autoPlay: true, loop: true })
    }
  })
  return found
}

function findSlideVideos(
  pres: Presentation,
  text: (name: string) => string | null,
  hasEntry: (name: string) => boolean,
): FoundVideo[] {
  const found: FoundVideo[] = []
  pres.slidePaths.forEach((slidePath, idx) => {
    if (pres.hidden.has(idx)) return
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
            x: x / pres.slideW,
            y: y / pres.slideH,
            w: cx / pres.slideW,
            h: cy / pres.slideH,
          }
        }
      }
      // Crop the source frame before fitting it into the shape.
      // Signed percentages can add margins in DrawingML.
      const srcRect = pic.match(/<a:srcRect\b[^>]*>/)
      let crop: SlideMedia['crop']
      if (srcRect) {
        const attrs = attrsOf(srcRect[0])
        const [left, top, right, bottom] = ['l', 't', 'r', 'b'].map((key) => Number(attrs[key] ?? 0) / 100_000)
        if ([left, top, right, bottom].every(Number.isFinite) && left + right < 1 && top + bottom < 1) {
          crop = { left, top, right, bottom }
        }
      }
      const shape = pic.match(/<p:cNvPr\b[^>]*>/)?.[0]
      const playback = shape ? parseVideoPlayback(slideXml, attrsOf(shape).id ?? '') : { autoPlay: false, loop: false }
      found.push({ slideIdx: idx, shapeId: shape && attrsOf(shape).id, mediaEntry, rect, ...(crop ? { crop } : {}), ...playback })
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
  animation?: Omit<SlideBuildAnimation, 'rect'>
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
    const filter = scope.match(/<p:animEffect\b[^>]*filter="([^"]+)"[^>]*>([\s\S]*?)<\/p:animEffect>/)
    const duration = filter?.[2].match(/<p:cTn\b[^>]*dur="(\d+)"/)
    const delay = Number(scope.match(/<p:cond\b[^>]*delay="([^"]+)"/)?.[1] ?? 0)
    let animation: StepTarget['animation']
    const kinds: Record<string, NonNullable<SlideBuildAnimation['kind']>> = { fade: 'fade', 'wipe(down)': 'wipe-up', 'barn(inVertical)': 'split-in-vertical' }
    if (filter && duration && kinds[filter[1]]) animation = { kind: kinds[filter[1]], durationMs: Number(duration[1]), ...(delay ? { delayMs: delay } : {}) }
    // Recognize only the authored linear vertical fly from below, not arbitrary formulas.
    const coordinates = [...scope.matchAll(/<p:anim\b[\s\S]*?<\/p:anim>/g)].map(m => m[0])
    const horizontal = coordinates.find(block => block.includes('>ppt_x<'))
    const fixedHorizontal = horizontal ? [...horizontal.matchAll(/<p:strVal\b[^>]*val="([^"]+)"/g)].map(m => m[1]) : []
    if (!filter && coordinates.length === 2 && fixedHorizontal?.length === 2 && fixedHorizontal.every(v => v === '#ppt_x') && scope.includes('ppt_y') && scope.includes('1+#ppt_h/2') && scope.includes('#ppt_y') && !scope.includes('<p:animMotion')) {
      const durations = [...scope.matchAll(/<p:cTn\b[^>]*dur="(\d+)"/g)].map(m => Number(m[1])).filter(n => n > 1)
      if (durations.length === 2 && durations[0] === durations[1] && scope.includes('calcmode="lin"')) animation = { kind: 'fly-bottom', durationMs: durations[0], ...(delay ? { delayMs: delay } : {}) }
    }
    if (!filter && !animation && !scope.includes('<p:anim') && scope.includes('style.visibility') && scope.includes('val="visible"')) animation = { kind: 'appear', durationMs: 1, ...(delay ? { delayMs: delay } : {}) }
    if (animation && (!Number.isFinite(delay) || delay < 0 || delay > 10000 || animation.durationMs <= 0 || animation.durationMs > 10000)) animation = undefined
    for (const m of scope.matchAll(/<p:spTgt spid="(\d+)"\s*(\/>|>[\s\S]*?<\/p:spTgt>)/g)) {
      const rg = m[2].match(/<p:pRg st="(\d+)" end="(\d+)"/)
      const t: StepTarget = rg
        ? { spid: m[1], whole: false, from: Number(rg[1]), to: Number(rg[2]) }
        : { spid: m[1], whole: true, from: 0, to: 0 }
      if (t.whole && animation) t.animation = animation
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

/** Compositing expects the background video to be the bottom authored shape. */
function videoForegroundShapes(xml: string, video: string): Map<string, string> | null {
  const tree = findBalanced(xml, 'p:spTree')
  if (!tree) return null
  const shapeTree = xml.slice(tree.start, tree.end)
  if (/<p:grpSp\b|<mc:AlternateContent\b/.test(shapeTree)) return null
  const shapes = new Map<string, string>()
  for (const tag of SHAPE_TAGS) for (const shape of topLevelBlocks(shapeTree, tag)) {
    const id = shape.match(/<p:cNvPr id="(\d+)"/)?.[1]
    if (!id) return null
    shapes.set(id, shape)
  }
  const background = shapes.get(video)
  if (!background || [...shapes.values()].some(shape => shapeTree.indexOf(shape) < shapeTree.indexOf(background))) return null
  return shapes
}

function hotspotRect(shape: string, width: number, height: number): SlideMedia['rect'] | undefined {
  const transform = shape.match(/<a:xfrm\b([^>]*)>([\s\S]*?)<\/a:xfrm>/)
  if (!transform) return undefined
  const off = attrsOf(transform[2].match(/<a:off\b[^>]*>/)?.[0] ?? '')
  const ext = attrsOf(transform[2].match(/<a:ext\b[^>]*>/)?.[0] ?? '')
  const angle = Number(attrsOf(transform[1]).rot ?? 0) * Math.PI / 10_800_000
  const cx = Number(ext.cx), cy = Number(ext.cy)
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle))
  const shapeWidth = cx * cos + cy * sin, shapeHeight = cx * sin + cy * cos
  const x = (Number(off.x) + (cx - shapeWidth) / 2) / width
  const y = (Number(off.y) + (cy - shapeHeight) / 2) / height
  const clippedX = Math.max(0, x), clippedY = Math.max(0, y)
  const w = Math.min(1, x + shapeWidth / width) - clippedX
  const h = Math.min(1, y + shapeHeight / height) - clippedY
  if (![clippedX, clippedY, w, h].every(Number.isFinite) || cx <= 0 || cy <= 0 || w <= 0 || h <= 0) return undefined
  return { x: clippedX, y: clippedY, w, h }
}

function shapeSlideLinks(shapes: Iterable<string>, rels: Map<string, string>, path: string, width: number, height: number) {
  return [...shapes].flatMap(shape => {
    const properties = findBalanced(shape, 'p:cNvPr')
    const links = properties ? shape.slice(properties.start, properties.end).matchAll(/<a:hlinkClick\b[^>]*>/g) : []
    for (const tag of links) {
      const attrs = attrsOf(tag[0])
      if (attrs.action !== 'ppaction://hlinksldjump') continue
      const target = rels.get(attrs['r:id'])
      const rect = hotspotRect(shape, width, height)
      if (target && rect) {
        const decoded = decodeXml(target)
        return [{ rect, shape: attrsOf(shape.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? '').id, ...(attrs.tooltip ? { label: decodeXml(attrs.tooltip) } : {}), path: decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(path), decoded) }]
      }
    }
    return []
  })
}

/** Read the PowerPoint coordinate expressions used by directional builds. */
function motionCoordinate(value: string, rect: SlideMedia['rect']): number | null {
  const expression = value.replace(/[#\s]/g, '')
  const variables: Record<string, number> = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: rect.w, h: rect.h }
  // Accept sums of literals and ppt_x/ppt_y/ppt_w/ppt_h, divided by a numerical constant.
  if (!/^(?:[+-]?(?:ppt_[xywh]|\d+(?:\.\d*)?|\.\d+)(?:\/\d+)?)(?:[+-](?:ppt_[xywh]|\d+(?:\.\d*)?|\.\d+)(?:\/\d+)?)*$/.test(expression)) return null
  const result = [...expression.matchAll(/([+-]?)(ppt_[xywh]|\d+(?:\.\d*)?|\.\d+)(?:\/(\d+))?/g)].reduce((total, [, sign, name, divisor]) =>
    total + (sign === '-' ? -1 : 1) * (name.startsWith('ppt_') ? variables[name.slice(-1)] : Number(name)) / Number(divisor ?? 1), 0)
  return Number.isFinite(result) && Math.abs(result) < 4 ? result : null
}

type ParsedForegroundActor = Omit<SlideForegroundActor, 'page'> & { id: string }

function timedEffects(sequence: string, startsOnEntry = false): Array<{ xml: string; startMs: number }> {
  const root = findBalanced(sequence, 'p:cTn')
  if (!root) return []
  const output: Array<{ xml: string; startMs: number }> = []
  const timing = new Map<string, { start: number; end: number }>()
  const visit = (node: string, offset: number, rootNode = false): void => {
    const attrs = attrsOf(node.match(/^<p:cTn\b[^>]*>/)?.[0] ?? '')
    const children = findBalanced(node, 'p:childTnLst')
    const head = children ? node.slice(0, children.start) : node
    const conditions = topLevelBlocks(head, 'p:stCondLst').flatMap(list => topLevelBlocks(list, 'p:cond'))
    const startMs = conditions.length && !rootNode ? Math.min(...conditions.map(condition => {
      const { delay, evt } = attrsOf(condition.match(/^<p:cond\b[^>]*>/)?.[0] ?? '')
      const ms = Number(delay ?? 0)
      const target = attrsOf(condition.match(/<p:tn\b[^>]*>/)?.[0] ?? '').val
      if (!Number.isFinite(ms) || ms < 0) return Infinity
      if (!evt) return offset + ms
      const source = timing.get(target)
      if (evt === 'onBegin' && source) return source.start + ms
      if (evt === 'onEnd' && source) return source.end + ms
      return Infinity
    })) : offset
    if (!Number.isFinite(startMs) || startMs > 60_000) return
    if (attrs.presetClass) {
      const duration = Math.max(0, ...[...node.matchAll(/<p:cTn\b[^>]*>/g)]
        .map(tag => Number(attrsOf(tag[0]).dur)).filter(value => Number.isFinite(value)))
      if (attrs.id) timing.set(attrs.id, { start: startMs, end: startMs + duration })
      if (!startsOnEntry || attrs.nodeType !== 'clickEffect') output.push({ xml: node, startMs })
      return
    }
    if (!children) return
    if (attrs.id) timing.set(attrs.id, { start: startMs, end: startMs + (Number(attrs.dur) || 0) })
    const direct = node.slice(children.start, children.end)
    for (const child of topLevelBlocks(direct, 'p:cTn')) visit(child, startMs)
  }
  const node = sequence.slice(root.start, root.end)
  visit(node, 0, true)
  return output
}

function parseForegroundActors(sequence: string, shapes: Map<string, string>, width: number, height: number, applyVisibility = false): ParsedForegroundActor[] {
  const actors: ParsedForegroundActor[] = []
  const entry = attrsOf(sequence.match(/<p:cTn\b[^>]*>/)?.[0] ?? '').nodeType === 'mainSeq'
  for (const { xml: effect, startMs } of timedEffects(sequence, entry)) {
    const attrs = attrsOf(effect.match(/^<p:cTn\b[^>]*>/)?.[0] ?? '')
    if (!['entr', 'exit', 'emph'].includes(attrs.presetClass) || !['withEffect', 'afterEffect', 'clickEffect'].includes(attrs.nodeType)) continue
    const id = effect.match(/<p:spTgt spid="(\d+)"/)?.[1]
    const shape = id && shapes.get(id)
    const rect = shape ? hotspotRect(shape, width, height) : undefined
    if (!id || !rect) continue
    const from = { x: 0, y: 0, opacity: 1 }, to = { ...from }
    let durationMs = 0
    const duration = (command: string): number => {
      const ms = Number(attrsOf(command.match(/<p:cTn\b[^>]*>/)?.[0] ?? '').dur)
      return Number.isFinite(ms) && ms > 0 && ms <= 10_000 ? ms : 0
    }
    for (const command of topLevelBlocks(effect, 'p:anim')) {
      const axis = command.match(/<p:attrName>ppt_([xy])<\/p:attrName>/)?.[1] as 'x' | 'y' | undefined
      if (!axis) continue
      const values = [...command.matchAll(/<p:strVal val="([^"]+)"/g)].map(value => motionCoordinate(value[1], rect))
      if (values.length !== 2 || values[0] === null || values[1] === null) continue
      const center = axis === 'x' ? rect.x + rect.w / 2 : rect.y + rect.h / 2
      from[axis] = values[0] - center
      to[axis] = values[1] - center
      durationMs = Math.max(durationMs, duration(command))
    }
    for (const command of topLevelBlocks(effect, 'p:animEffect')) {
      const fade = attrsOf(command.match(/<p:animEffect\b[^>]*>/)?.[0] ?? '')
      if (fade.filter !== 'fade') continue
      from.opacity = fade.transition === 'in' ? 0 : 1
      to.opacity = fade.transition === 'out' ? 0 : 1
      durationMs = Math.max(durationMs, duration(command))
    }
    const rotations: NonNullable<SlideForegroundActor['rotations']> = [{ timeMs: 0, degrees: 0 }]
    if (attrs.repeatCount === 'indefinite') for (const command of topLevelBlocks(effect, 'p:animRot')) {
      const degrees = Number(attrsOf(command.match(/<p:animRot\b[^>]*>/)?.[0] ?? '').by) / 60_000
      const ms = duration(command)
      if (!ms || !Number.isFinite(degrees)) continue
      const last = rotations.at(-1)!
      const begin = Number(attrsOf(command.match(/<p:stCondLst>\s*<p:cond\b[^>]*>/)?.[0] ?? '').delay ?? last.timeMs)
      if (!Number.isFinite(begin) || begin < last.timeMs || begin + ms > 60_000) continue
      if (begin > last.timeMs) rotations.push({ timeMs: begin, degrees: last.degrees })
      rotations.push({ timeMs: begin + ms, degrees: last.degrees + degrees })
    }
    if (rotations.length > 1) durationMs = rotations.at(-1)!.timeMs
    if (!durationMs && applyVisibility && /<p:attrName>style.visibility<\/p:attrName>/.test(effect)) {
      const visible = /<p:strVal val="visible"/.test(effect)
      from.opacity = Number(!visible)
      to.opacity = Number(visible)
      durationMs = 1
    }
    if (!durationMs) continue
    if (attrs.presetClass === 'exit' && to.opacity === 1 && !to.x && !to.y) to.opacity = 0
    const motion = { startMs, durationMs, from, to, ...(rotations.length > 1 ? { rotations } : {}) }
    const existing = actors.find(actor => actor.id === id)
    if (existing) {
      const previous = existing.following?.at(-1) ?? existing
      if (startMs >= previous.startMs + previous.durationMs) (existing.following ??= []).push(motion)
      continue
    }
    const x = Math.max(0, rect.x - .035), y = Math.max(0, rect.y - .035)
    actors.push({ id, rect: { x, y, w: Math.min(1, rect.x + rect.w + .035) - x, h: Math.min(1, rect.y + rect.h + .035) - y },
      pivot: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, ...motion })
  }
  return actors
}

function mainSequence(xml: string): string {
  const timing = findBalanced(xml, 'p:timing')
  return timing ? topLevelBlocks(xml.slice(timing.start, timing.end), 'p:seq')
    .find(seq => attrsOf(seq.match(/<p:cTn\b[^>]*>/)?.[0] ?? '').nodeType === 'mainSeq') ?? '' : ''
}

/** A delayed entrance in the first automatic build gates its clickable shape. */
function videoMenuButtonDelay(timing: string, shapeId: string): number {
  const sequence = topLevelBlocks(timing, 'p:seq')
    .find(seq => attrsOf(seq.match(/<p:cTn\b[^>]*>/)?.[0] ?? '').nodeType === 'mainSeq')
  if (!sequence) return 0
  for (const tag of sequence.matchAll(/<p:cTn\b[^>]*>/g)) {
    const { nodeType, presetClass } = attrsOf(tag[0])
    if (nodeType !== 'withEffect' || presetClass !== 'entr') continue
    const block = findBalanced(sequence, 'p:cTn', tag.index)
    if (!block) continue
    const effect = sequence.slice(block.start, block.end)
    if (![...effect.matchAll(/<p:spTgt\b[^>]*>/g)].some(target => attrsOf(target[0]).spid === shapeId)) continue
    const condition = effect.match(/<p:stCondLst>\s*<p:cond\b[^>]*>/)?.[0] ?? ''
    const delay = Number(attrsOf(condition).delay)
    if (Number.isFinite(delay) && delay > 0 && delay <= 60_000) return delay
  }
  return 0
}

/** Match a shape click that dismisses one set of objects and reveals another. */
function parseVideoMenu(xml: string, video: string, shapes: Map<string, string>, width: number, height: number) {
  const timing = findBalanced(xml, 'p:timing')
  if (!timing) return null
  for (const { shape: button, sequence } of interactiveSequences(xml)) {
    const shape = shapes.get(button)
    const rect = shape && hotspotRect(shape, width, height)
    if (!rect) continue

    const hide = new Set<string>(), show = new Set<string>()
    for (const effect of topLevelBlocks(sequence, 'p:set')) {
      if (!effect.includes('<p:attrName>style.visibility</p:attrName>')) continue
      const id = effect.match(/<p:spTgt spid="(\d+)"/)?.[1]
      const value = effect.match(/<p:strVal val="(hidden|visible)"/)?.[1]
      if (id && value) (value === 'hidden' ? hide : show).add(id)
    }
    if (!hide.has(button) || !show.size || [...hide, ...show].some(id => id === video || !shapes.has(id)) ||
        [...show].some(id => hide.has(id))) continue
    // Only handle a menu: the click reveals at least one authored slide link.
    if (![...show].some(id => shapes.get(id)?.includes('ppaction://hlinksldjump'))) continue
    const staticSlide = xml.slice(0, timing.start) + xml.slice(timing.end)
    return {
      button: rect,
      initial: [...show].reduce(removeShape, staticSlide),
      menu: [...hide].reduce(removeShape, staticSlide),
      revealedShapes: [...shapes].filter(([id]) => !hide.has(id)).map(([, shape]) => shape),
      trigger: button,
      sequence,
      buttonDelayMs: videoMenuButtonDelay(xml.slice(timing.start, timing.end), button),
    }
  }
  return null
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

// ── 2.23: заметки докладчика ─────────────────────────────────────────────────

/** Текст заметок слайда: плейсхолдер body в его notesSlide; нет — null. */
function slideNotesText(slidePath: string, text: (name: string) => string | null): string | null {
  const relsXml = text(relsPathOf(slidePath))
  if (!relsXml) return null
  const target = [...parseRels(relsXml, NOTES_REL_TYPE).values()][0]
  if (!target) return null
  const notesXml = text(normalizeSlideTarget(target))
  if (!notesXml) return null

  const parts: string[] = []
  for (const sp of topLevelBlocks(notesXml, 'p:sp')) {
    // Картинка слайда, номер, колонтитулы — мимо; текст докладчика только в body.
    if (!/<p:ph\b[^>]*type="body"/.test(sp)) continue
    const body = findBalanced(sp, 'p:txBody')
    if (!body) continue
    // Абзац = строка; внутри — раны (a:t, в т.ч. в полях a:fld) и мягкие переносы a:br.
    const lines = topLevelBlocks(sp.slice(body.start, body.end), 'a:p').map((p) => {
      let line = ''
      for (const m of p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t\s*\/>|<a:br\b[^>]*>/g)) {
        line += m[0].startsWith('<a:br') ? '\n' : decodeXml(m[1] ?? '')
      }
      return line
    })
    parts.push(lines.join('\n'))
  }
  const out = parts.join('\n').replace(/\s+$/, '')
  return out.trim() ? out : null
}

// ── Трансформация PPTX целиком ───────────────────────────────────────────────

interface NativeFrameRequest { slidePath: string; shapeId: string; targetY: number; frameCount: number; effect: string }

interface TransformResult {
  nativeFrames?: Record<string, NativeFrameRequest>
  foregroundPages?: Array<{ path: string; xml: string }>
  audioEntries?: Set<string>
  /** null — пересборка не нужна (нет ни видео, ни клик-анимаций). */
  zip: Buffer | null
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, import('../shared/pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('../shared/types.js').SlideVideoLink[]>
  slideKiosk?: boolean
  slideNumbering?: import('../shared/slide-numbering').SlideNumbering
  videos: FoundVideo[]
  pageNotes: Record<number, string>
  fonts: string[]
  requiresFreshPdf: boolean
}

function transformPptx(data: Buffer, entries: ZipEntry[], renderer: 'libreoffice' | 'powerpoint' = 'libreoffice'): TransformResult {
  const byName = new Map(entries.map((e) => [e.name, e]))
  const textCache = new Map<string, string | null>()
  const compatibleSlides = new Map<string, Buffer>()
  const text = (name: string): string | null => {
    if (!textCache.has(name)) {
      const e = byName.get(name)
      let xml = e ? readEntry(data, e).toString('utf8') : null
      if (xml && /^ppt\/slides\/[^/]+\.xml$/.test(name)) {
        const original = xml
        const rels = parseRels(text(relsPathOf(name)) ?? '')
        if (renderer === 'libreoffice') xml = preferChartPreviews(xml, rid => {
          const target = rels.get(rid)
          const image = target && byName.get(normalizeSlideTarget(target))
          if (!image) return false
          const bytes = readEntry(data, image)
          return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
            ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
        })
        xml = freezeSlideNumbers(xml)
        if (xml !== original) compatibleSlides.set(name, Buffer.from(xml))
      }
      textCache.set(name, xml)
    }
    return textCache.get(name)!
  }

  const pres = parsePresentation(text)
  if (!pres) return { zip: null, slideMedia: [], videos: [], pageNotes: {}, fonts: [], requiresFreshPdf: false }

  const videos = findSlideVideos(pres, text, (n) => byName.has(n))
  const gifs = findSlideGifs(pres, text, data, byName)
  const fonts = requestedFonts(
    entries.map((e) => e.name),
    text,
    pres.slidePaths.filter((_, i) => !pres.hidden.has(i)),
  )
  const videoSlides = new Set(videos.map((v) => v.slideIdx))

  // Шаги анимаций; слайды с видео не разворачиваем (клик-запуск ролика
  // конфликтовал бы с шагами).
  const stepsBySlide = new Map<number, StepTarget[][]>()
  pres.slidePaths.forEach((slidePath, idx) => {
    if (videoSlides.has(idx) || pres.hidden.has(idx)) return
    const slideXml = text(slidePath)
    if (!slideXml) return
    const clicks = parseClickSteps(slideXml)
    if (clicks.length > 0) stepsBySlide.set(idx, clicks)
  })

  const strip = new Set(
    (renderer === 'powerpoint' ? [] : entries)
      .filter((e) => e.name.startsWith('ppt/media/') && STRIP_EXTS.has(extOf(e.name)))
      .map((e) => e.name),
  )

  // Номера страниц после разворачивания: слайд idx начинается со страницы
  // firstPage[idx]. Скрытый слайд страниц не занимает (LibreOffice его не выводит).
  let page = 0
  const slideNumbering: import('../shared/slide-numbering').SlideNumbering = { total: pres.slidePaths.length, pages: [] }
  const firstPage: number[] = []
  const pageNotes: Record<number, string> = {}
  pres.slidePaths.forEach((slidePath, idx) => {
    if (pres.hidden.has(idx)) return
    firstPage[idx] = page + 1
    const pages = 1 + (stepsBySlide.get(idx)?.length ?? 0)
    // Заметка слайда — на все его шаги: докладчик говорит одно и то же, пока идёт билд.
    const note = slideNotesText(slidePath, text)
    if (note) for (let k = 0; k < pages; k++) pageNotes[page + 1 + k] = note
    for (let k = 0; k < pages; k++) slideNumbering.pages.push(k ? `${idx + 1}.${k}` : String(idx + 1))
    page += pages
  })

  const slideMedia: SlideMedia[] = videos.map((v) => ({
    slide: firstPage[v.slideIdx],
    rect: v.rect,
    autoPlay: v.autoPlay,
    loop: v.loop,
    ...(v.crop ? { crop: v.crop } : {}),
    file: mediaFileName(v.mediaEntry),
  }))
  const slideBuilds: Record<number, SlideBuildAnimation> = {}
  const slideLinks: Record<number, SlideVideoLink[]> = {}
  const slideKiosk = /<p:kiosk\b/.test(text('ppt/presProps.xml') ?? '')
  const pageByPath = new Map(pres.slidePaths.map((path, index) => [path, firstPage[index]]))
  pres.slidePaths.forEach((path, index) => {
    const page = firstPage[index]
    const xml = text(path)
    if (!page || !xml || !xml.includes('ppaction://hlinksldjump')) return
    const tree = findBalanced(xml, 'p:spTree')
    if (!tree) return
    const contents = xml.slice(tree.start, tree.end)
    const groups = topLevelBlocks(contents, 'p:grpSp')
    const ungrouped = groups.reduce((out, group) => out.replace(group, ''), contents)
    const shapes = SHAPE_TAGS.flatMap(tag => topLevelBlocks(ungrouped, tag))
      .sort((left, right) => ungrouped.indexOf(left) - ungrouped.indexOf(right))
    const rels = parseRels(text(relsPathOf(path)) ?? '', SLIDE_REL_TYPE)
    const steps = stepsBySlide.get(index) ?? []
    for (let step = 0; step <= steps.length; step++) {
      const hidden = new Set(steps.slice(step).flat().filter(target => target.whole).map(target => target.spid))
      const shown = shapes.filter(shape => !hidden.has(shape.match(/<p:cNvPr id="(\d+)"/)?.[1] ?? ''))
      const links = shapeSlideLinks(shown, rels, path, pres.slideW, pres.slideH).flatMap(jump => {
        const slide = pageByPath.get(jump.path)
        return slide && jump.path !== path ? [{ slide, rect: jump.rect, label: jump.label }] : []
      })
      if (links.length) slideLinks[page + step] = links
    }
  })
  const nativeFrames: Record<string, NativeFrameRequest> = {}
  if (renderer === 'powerpoint') for (const [index, steps] of stepsBySlide) {
    const xml = text(pres.slidePaths[index])!
    steps.forEach((targets, step) => {
      if (targets.length !== 1 || !targets[0].whole || !targets[0].animation) return
      const target = targets[0]
      const block = [...topLevelBlocks(xml, 'p:sp'), ...topLevelBlocks(xml, 'p:pic')].find(sp => sp.match(/<p:cNvPr\b[^>]*\bid="([^"]+)"/)?.[1] === target.spid)
      const transform = block?.match(/<a:xfrm\b([^>]*)>([\s\S]*?)<\/a:xfrm>/)
      if (!transform || /rot=/.test(transform[1])) return
      const off = transform[2].match(/<a:off\b[^>]*>/), ext = transform[2].match(/<a:ext\b[^>]*>/)
      if (!off || !ext) return
      const a = attrsOf(off[0]), b = attrsOf(ext[0])
      const raw = { x: Number(a.x) / pres.slideW, y: Number(a.y) / pres.slideH, w: Number(b.cx) / pres.slideW, h: Number(b.cy) / pres.slideH }
      const rect = { x: Math.max(0, raw.x), y: Math.max(0, raw.y), w: Math.min(1, raw.x + raw.w) - Math.max(0, raw.x), h: Math.min(1, raw.y + raw.h) - Math.max(0, raw.y) }
      if (!Object.values(rect).every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > 1 || rect.y + rect.h > 1) return
      if (target.animation!.kind === 'fly-bottom') {
        if (!block!.startsWith('<p:pic') || /<a:(?:alpha|outerShdw|innerShdw)/.test(block!)) return
        const rid = block!.match(/<a:blip\b[^>]*r:embed="([^"]+)"/)?.[1]
        const rels = parseRels(text(relsPathOf(pres.slidePaths[index])) ?? '')
        const image = rid && rels.get(rid)
        const entry = image && byName.get(normalizeSlideTarget(image))
        if (!entry || !readEntry(data, entry).subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return
        // A raster crop would also move foreground text. Only unobstructed
        // opaque pictures are safe until independent foreground layers exist.
        const visible = buildStepXml(xml, steps.slice(step + 1).flat())
        const pictureAt = visible.indexOf(block!)
        if (pictureAt < 0) return
        const above = visible.slice(pictureAt + block!.length)
        let occluded = false
        for (const tag of SHAPE_TAGS) for (const shape of topLevelBlocks(above, tag)) {
          const xf = shape.match(/<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/)
          const o = xf?.[1].match(/<a:off\b[^>]*>/), e = xf?.[1].match(/<a:ext\b[^>]*>/)
          if (!o || !e) { occluded = true; continue }
          const origin = attrsOf(o[0]), size = attrsOf(e[0])
          const x = Number(origin.x) / pres.slideW, y = Number(origin.y) / pres.slideH
          const w = Number(size.cx) / pres.slideW, h = Number(size.cy) / pres.slideH
          if (![x,y,w,h].every(Number.isFinite)) { occluded = true; continue }
          if (x < raw.x + raw.w && x + w > raw.x && y < raw.y + raw.h && y + h > raw.y) occluded = true
        }
        if (occluded) {
          const file = `build-${firstPage[index] + step + 1}.pdf`
          nativeFrames[file] = { slidePath: pres.slidePaths[index].replace(/\.xml$/, `_cd${step+1}.xml`), shapeId: target.spid, targetY: Number(a.y), frameCount: 16, effect: 'fly-bottom' }
          target.animation = { ...target.animation!, kind: 'native-frames', framesFile: file, frameCount: 16 }
          rect.y = 0; rect.h = 1
        }
      }
      if (block!.startsWith('<p:pic') && ['wipe-down','wipe-up','split-in-vertical'].includes(target.animation!.kind ?? '')) {
        const file = `build-${firstPage[index] + step + 1}.pdf`
        nativeFrames[file] = { slidePath: pres.slidePaths[index].replace(/\.xml$/, `_cd${step+1}.xml`), shapeId: target.spid, targetY: Number(a.y), frameCount: 16, effect: target.animation!.kind! }
        target.animation = { ...target.animation!, kind: 'native-frames', framesFile: file, frameCount: 16 }
      }
      slideBuilds[firstPage[index] + step + 1] = { ...target.animation!, rect }
    })
  }
  const slideTransitions: Record<number, import('../shared/pptx-transition.js').PptxSlideTransition> = {}
  pres.slidePaths.forEach((path, index) => {
    if (pres.hidden.has(index)) return
    const duration = pptxSlideTransition(text(path) ?? '')
    slideTransitions[firstPage[index]] = duration
  })

  for (const gif of gifs) {
    const original = text(pres.slidePaths[gif.slideIdx])!
    const steps = stepsBySlide.get(gif.slideIdx) ?? []
    for (let step = 0; step <= steps.length; step++) {
      const visible = buildStepXml(original, steps.slice(step).flat())
      if (!topLevelBlocks(visible, 'p:pic').some(pic => {
        const shape = pic.match(/<p:cNvPr\b[^>]*>/)?.[0]
        return shape && attrsOf(shape).id === gif.shapeId
      })) continue
      slideMedia.push({ kind: 'gif', slide: firstPage[gif.slideIdx] + step,
        rect: gif.rect, crop: gif.crop, file: mediaFileName(gif.mediaEntry) })
    }
  }
  videos.push(...gifs)

  const foregroundPages: NonNullable<TransformResult['foregroundPages']> = []
  const audioEntries = new Set<string>()
  const collectAudio = (path: string, xml: string, shapes: Map<string, string>, rels: Map<string, string>, shapeId?: string, menuTrigger?: string) => {
    const { cues, clicks } = inlineAudioCues(xml, shapes, parseRels(text(relsPathOf(path)) ?? ''), menuTrigger)
    const audio = cues.filter(entry => byName.has(entry.mediaEntry))
    const linked = shapeSlideLinks(shapes.values(), rels, path, pres.slideW, pres.slideH)
    const linkedShapes = new Set(linked.map(link => link.shape))
    const clickActions = clicks.flatMap(({ shape, commands }) => {
      if (shape === menuTrigger || linkedShapes.has(shape)) return []
      const element = shapes.get(shape)
      const rect = element && hotspotRect(element, pres.slideW, pres.slideH)
      if (!rect) return []
      const restartVideo = commands.some(command => command.shape === shapeId && command.delayMs === 0)
      const hasSound = audio.some(({ cue }) => cue.trigger === 'click' && cue.shape === shape)
      if (!restartVideo && !hasSound) return []
      const label = decodeXml(attrsOf(element.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? '').name || shape)
      return [{ shape, rect, label, ...(restartVideo ? { restartVideo } : {}) }]
    })
    for (const entry of audio) audioEntries.add(entry.mediaEntry)
    return { audio: audio.map(entry => entry.cue), clickActions, linked }
  }
  if (renderer === 'libreoffice') {
    for (const [index, path] of pres.slidePaths.entries()) {
      const page = firstPage[index]
      const xml = text(path) ?? ''
      if (!page || !/<a:audioFile\b/.test(xml)) continue
      const tree = findBalanced(xml, 'p:spTree')
      if (!tree) continue
      const shapes = slideAudioShapes(xml.slice(tree.start, tree.end))
      const steps = stepsBySlide.get(index) ?? []
      const rels = parseRels(text(relsPathOf(path)) ?? '', SLIDE_REL_TYPE)
      const { audio, clickActions, linked } = collectAudio(path, xml, shapes, rels)
      for (let step = 0; step <= steps.length; step++) {
        const hidden = new Set(steps.slice(step).flat().filter(target => target.whole).map(target => target.spid))
        const cues = audio.filter(cue => cue.trigger === 'click' ? !hidden.has(cue.shape) : step === 0)
        if (!cues.length) continue
        const slide = page + step
        const actions = clickActions.filter(action => !hidden.has(action.shape))
        const video = slideMedia.find(item => item.slide === slide && !item.kind)
        if (video) {
          video.audio = cues
          video.clickActions = actions
        } else {
          slideMedia.push({ kind: 'audio', slide, file: cues[0].file, rect: { x: 0, y: 0, w: 1, h: 1 }, audio: cues, clickActions: actions })
        }
        const links = slideLinks[slide] ?? []
        for (const link of links) {
          const match = linked.find(item =>
            pageByPath.get(item.path) === link.slide && item.rect.x === link.rect.x && item.rect.y === link.rect.y)
          if (match && cues.some(cue => cue.trigger === 'click' && cue.shape === match.shape)) link.triggerShape = match.shape
        }
      }
    }
  }
  if (renderer === 'powerpoint') {
    const scenes = new Map(videos.flatMap((video, index) => {
      if (!video.shapeId || video.kind === 'gif' ||
          video.rect.x !== 0 || video.rect.y !== 0 || video.rect.w !== 1 || video.rect.h !== 1) return []
      const path = pres.slidePaths[video.slideIdx]
      const xml = text(path)!
      const shapes = videoForegroundShapes(xml, video.shapeId)
      if (!shapes) return []
      const rels = parseRels(text(relsPathOf(path)) ?? '', SLIDE_REL_TYPE)
      return [[path, { index, xml, shapes, rels, video, shapeId: video.shapeId }] as const]
    }))
    const appendForeground = (path: string, state: string, video: string): void => {
      let foreground = removeShape(state, video)
      const timing = findBalanced(foreground, 'p:timing')
      if (timing) foreground = foreground.slice(0, timing.start) + foreground.slice(timing.end)
      for (const picture of topLevelBlocks(foreground, 'p:pic')) {
        if (/<a:audioFile\b/.test(picture)) foreground = foreground.replace(picture, '')
      }
      foreground = foreground.replace(/<a:hlink(?:Click|Hover)\b[^>]*(?:\/>|>[\s\S]*?<\/a:hlink(?:Click|Hover)>)/g, '')
      for (const color of ['000000', 'FFFFFF']) {
        const background = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
        const xml = foreground.replace(/<p:sld(?=[\s>])([^>]*)>/, (_tag, attrs: string) =>
          `<p:sld${attrs.replace(/\s+showMasterSp="[^"]*"/, '')} showMasterSp="0">`)
          .replace(/<p:cSld\b[^>]*>(?:\s*<p:bg\b[^>]*>[\s\S]*?<\/p:bg>)?/, start =>
            start.replace(/<p:bg\b[\s\S]*/, '') + background)
        foregroundPages.push({ path, xml })
      }
    }
    const appendMotion = (path: string, original: string, state: string, video: string, shapes: Map<string, string>, sequence: string): SlideForegroundMotion | undefined => {
      const actors = parseForegroundActors(sequence, shapes, pres.slideW, pres.slideH)
        .filter(actor => actor.id !== video).slice(0, 16)
        .sort((a, b) => original.indexOf(shapes.get(a.id)!) - original.indexOf(shapes.get(b.id)!))
      if (!actors.length) return undefined
      const basePage = foregroundPages.length + 1
      appendForeground(path, actors.reduce((xml, actor) => removeShape(xml, actor.id), state), video)
      return {
        basePage,
        actors: actors.map(({ id, ...actor }) => {
          const page = foregroundPages.length + 1
          const isolated = [...shapes.keys()].reduce((xml, shapeId) => shapeId === id ? xml : removeShape(xml, shapeId), original)
          appendForeground(path, isolated, video)
          return { ...actor, page }
        }),
      }
    }
    const file = 'video-foreground.pdf'
    for (const [index, path] of pres.slidePaths.entries()) {
      const page = firstPage[index]
      const xml = text(path) ?? ''
      if (!page || scenes.has(path) || !/<a:audioFile\b|nodeType="interactiveSeq"/.test(xml)) continue
      const tree = findBalanced(xml, 'p:spTree')
      if (!tree) continue
      const contents = xml.slice(tree.start, tree.end)
      const shapes = slideAudioShapes(contents)
      const rels = parseRels(text(relsPathOf(path)) ?? '', SLIDE_REL_TYPE)
      const video = videos.find(item => item.slideIdx === index && !item.kind)
      const { audio, clickActions, linked } = collectAudio(path, xml, shapes, rels, video?.shapeId)
      const ordered = [...shapes].sort((a, b) => contents.indexOf(a[1]) - contents.indexOf(b[1]))
        .filter(([, shape]) => !/<a:audioFile\b/.test(shape))
      const targets = new Map<string, { rect: SlideMedia['rect']; initiallyHidden: boolean }>()
      const sequences = !videos.some(item => item.slideIdx === index) && !stepsBySlide.has(index) && !/<p:grpSp\b|<mc:AlternateContent\b/.test(contents)
        ? interactiveSequences(xml) : []
      const triggers: SlideTrigger[] = sequences.flatMap(({ shape, sequence, restart }, i) => {
        const button = shapes.get(shape)
        const rect = button && hotspotRect(button, pres.slideW, pres.slideH)
        if (!rect || linked.some(link => link.shape === shape)) return []
        const actors = parseForegroundActors(sequence, shapes, pres.slideW, pres.slideH, true)
        if (!actors.length || actors.some(actor => !ordered.some(([id]) => id === actor.id))) return []
        const effects = actors.flatMap(({ id, rect, pivot: _pivot, following, ...step }) => {
          if (!targets.has(id) || step.from.opacity === 0)
            targets.set(id, { rect, initiallyHidden: step.from.opacity === 0 || step.to.opacity === 1 && Boolean(step.from.x || step.from.y) })
          return [step, ...(following ?? [])].map(item => ({ ...item, shape: id }))
        })
        const label = decodeXml(attrsOf(button.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? '').name || shape)
        return [{ id: String(i), shape, rect, label, restart, durationMs: Math.max(
          ...effects.map(effect => effect.startMs + effect.durationMs),
          ...audio.filter(cue => cue.trigger === 'click' && cue.shape === shape).map(cue => (cue.delayMs ?? 0) + 1),
        ), effects }]
      })
      let interactive: SlideMedia['interactive']
      if (triggers.length && triggers.length <= 32 && targets.size <= 12 && foregroundPages.length < 500) {
        const select = (keep: Set<string>, source: string): string =>
          [...shapes.keys()].reduce((out, id) => keep.has(id) ? out : removeShape(out, id), source)
        const timing = findBalanced(xml, 'p:timing')!
        const still = xml.slice(0, timing.start) + xml.slice(timing.end)
        const firstPage = foregroundPages.length + 1
        const firstActor = ordered.findIndex(([id]) => targets.has(id))
        const backgroundShapes = new Set(ordered.slice(0, firstActor).map(([id]) => id))
        const fullSlide = { x: 0, y: 0, w: 1, h: 1 }
        foregroundPages.push({ path, xml: select(backgroundShapes, still)
          .replace(/<a:hlink(?:Click|Hover)\b[^>]*\/>/g, '') })
        const layers: SlideInteractiveLayer[] = []
        let staticShapes = new Set<string>()
        const flush = (): void => {
          if (!staticShapes.size) return
          layers.push({ page: foregroundPages.length + 1, rect: fullSlide })
          appendForeground(path, select(staticShapes, still), '')
          staticShapes = new Set()
        }
        for (const [id] of ordered.slice(firstActor)) {
          const target = targets.get(id)
          if (!target) { staticShapes.add(id); continue }
          flush()
          layers.push({ page: foregroundPages.length + 1, shape: id, ...target })
          appendForeground(path, select(new Set([id]), still), '')
        }
        flush()
        interactive = { file, firstPage, triggers, layers }
        const initial = [...targets].reduce((out, [id, target]) =>
          target.initiallyHidden ? removeShape(out, id) : out, still)
        compatibleSlides.set(path, Buffer.from(initial))
      }
      if (!audio.length && !clickActions.length && !interactive) continue
      const media = slideMedia.find(item => item.slide === page && !item.kind)
      if (media) {
        if (audio.length) media.audio = audio
        if (clickActions.length) media.clickActions = clickActions
      } else if (audio.length || interactive) {
        slideMedia.push({ kind: interactive ? 'interactive' : 'audio', slide: page, file: interactive?.file ?? audio[0].file,
          rect: { x: 0, y: 0, w: 1, h: 1 }, audio, clickActions, interactive })
      }
      for (const link of slideLinks[page] ?? []) {
        const match = linked.find(item => pageByPath.get(item.path) === link.slide &&
          item.rect.x === link.rect.x && item.rect.y === link.rect.y)
        if (match && audio.some(cue => cue.trigger === 'click' && cue.shape === match.shape)) link.triggerShape = match.shape
      }
    }
    for (const [path, { index, xml, shapes, rels, video, shapeId }] of scenes) {
      const settings = mediaTiming(xml, 'p:video', shapeId)
      if (settings) slideMedia[index].volume = settings.volume
      const menu = video.autoPlay && video.loop ? parseVideoMenu(xml, shapeId, shapes, pres.slideW, pres.slideH) : null
      const { audio, clickActions } = collectAudio(path, xml, shapes, rels, shapeId, menu?.trigger)
      if (audio.length) slideMedia[index].audio = audio
      if (clickActions.length) slideMedia[index].clickActions = clickActions
      if (!menu) continue

      const links: SlideVideoLink[] = []
      for (const jump of shapeSlideLinks(menu.revealedShapes, rels, path, pres.slideW, pres.slideH)) {
        const page = pageByPath.get(jump.path)
        if (!page || page === slideMedia[index].slide) continue
        const destination = scenes.get(jump.path)
        if (destination && !destination.video.loop) {
          const target = slideMedia[destination.index]
          const back = shapeSlideLinks(destination.shapes.values(), destination.rels, jump.path, pres.slideW, pres.slideH)
            .find(link => link.path === path)
          if (back && !target.foreground) {
            target.foreground = {
              kind: 'return', file, firstPage: foregroundPages.length + 1,
              link: { slide: slideMedia[index].slide, rect: back.rect },
            }
            appendForeground(jump.path, destination.xml, destination.shapeId)
          }
        }
        links.push({ slide: page, rect: jump.rect, ...(audio.some(cue => cue.trigger === 'click' && cue.shape === jump.shape) ? { triggerShape: jump.shape } : {}) })
      }
      const firstPage = foregroundPages.length + 1
      compatibleSlides.set(path, Buffer.from(menu.initial))
      appendForeground(path, menu.initial, shapeId)
      appendForeground(path, menu.menu, shapeId)
      if (menu.buttonDelayMs) appendForeground(path, removeShape(menu.initial, menu.trigger), shapeId)
      const entry = appendMotion(path, xml, menu.initial, shapeId, shapes, mainSequence(xml))
      const reveal = appendMotion(path, xml, menu.menu, shapeId, shapes, menu.sequence)
      slideMedia[index].foreground = {
        kind: 'menu', file, firstPage, button: menu.button, links,
        ...(menu.buttonDelayMs ? { buttonDelayMs: menu.buttonDelayMs } : {}),
        ...(entry || reveal ? { motion: { entry, menu: reveal } } : {}),
      }
    }
    for (const [path, { index, xml, shapes, rels, video, shapeId }] of scenes) {
      if (!video.autoPlay || !video.loop || slideMedia[index].foreground) continue
      const visible = [...shapes].filter(([id, shape]) => id !== shapeId && !/<a:audioFile\b/.test(shape) &&
        hotspotRect(shape, pres.slideW, pres.slideH))
      if (!visible.length) continue
      const links = shapeSlideLinks(visible.map(([, shape]) => shape), rels, path, pres.slideW, pres.slideH)
        .flatMap(jump => {
          const slide = pageByPath.get(jump.path)
          return slide && slide !== slideMedia[index].slide ? [{ rect: jump.rect, slide }] : []
        })
      const firstPage = foregroundPages.length + 1
      appendForeground(path, xml, shapeId)
      const entry = appendMotion(path, xml, xml, shapeId, shapes, mainSequence(xml))
      slideMedia[index].foreground = { kind: 'static', file, firstPage, links, ...(entry ? { motion: { entry } } : {}) }
    }
  }

  const requiresFreshPdf = compatibleSlides.size > 0 || gifs.length > 0
  if (strip.size === 0 && stepsBySlide.size === 0 && gifs.length === 0 && compatibleSlides.size === 0) return { zip: null, slideMedia, slideTransitions, slideNumbering, slideBuilds, slideLinks, slideKiosk, nativeFrames, foregroundPages, audioEntries, videos, pageNotes, fonts, requiresFreshPdf }

  const replace = new Map(compatibleSlides)
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

  // Remove only animated instances; a static first frame underneath would ghost
  // through transparent/disposal frames. Keep the original GIF bytes for extraction.
  for (const gif of gifs) {
    const path = pres.slidePaths[gif.slideIdx]
    const original = replace.get(path)?.toString('utf8') ?? text(path)!
    replace.set(path, Buffer.from(removeShape(original, gif.shapeId!)))
    for (const extra of add) {
      if (extra.name.startsWith(path.replace(/\.xml$/, '_cd')) && extra.name.endsWith('.xml')) {
        extra.data = Buffer.from(removeShape(extra.data.toString('utf8'), gif.shapeId!))
      }
    }
  }
  return { zip: rebuildZip(data, entries, { strip, replace, add }), slideMedia, slideTransitions, slideNumbering, slideBuilds, slideLinks, slideKiosk, nativeFrames, foregroundPages, audioEntries, videos, pageNotes, fonts, requiresFreshPdf }
}

/** A short frame deck preserves PowerPoint z-order, including static text above a moving picture. */
function nativeFrameDeck(data: Buffer, request: NativeFrameRequest): Buffer {
  const entries = parseZip(data), byName = new Map(entries.map(e => [e.name,e]))
  const read = (name: string): string => { const e=byName.get(name); if(!e) throw new Error(`Missing native frame part: ${name}`); return readEntry(data,e).toString('utf8') }
  const xml = read(request.slidePath)
  const picture = topLevelBlocks(xml,'p:pic').find(block=>block.match(/<p:cNvPr\b[^>]*id="([^"]+)"/)?.[1]===request.shapeId)
  if (!picture) throw new Error('Native frame target missing')
  const height = Number(read('ppt/presentation.xml').match(/<p:sldSz\b[^>]*cy="(\d+)"/)?.[1])
  if (!height) throw new Error('Native frame slide height missing')
  const pages = Array.from({ length: request.frameCount }, (_, i) => {
    const y=Math.round(height+(request.targetY-height)*i/(request.frameCount-1))
    const progress=i/(request.frameCount-1)
    let moved = picture
    if (request.effect === 'fly-bottom') {
      moved=picture.replace(/(<a:xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\by=")[^"]+("[^>]*>)/,(_m,a:string,b:string)=>a+y+b)
    } else if (progress === 0) moved = ''
    else if (progress < 1) {
      const transform=picture.match(/<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/)![1]
      const off=attrsOf(transform.match(/<a:off\b[^>]*>/)![0]), ext=attrsOf(transform.match(/<a:ext\b[^>]*>/)![0])
      const originalCrop=attrsOf(picture.match(/<a:srcRect\b[^>]*>/)?.[0] ?? '')
      const crop=(l:number,t:number,r:number,b:number, x:number,w:number,h:number,id:string,y=Number(off.y)):string=>{
        const margins = { l:Number(originalCrop.l??0),t:Number(originalCrop.t??0),r:Number(originalCrop.r??0),b:Number(originalCrop.b??0) }
        const sourceW=100000-margins.l-margins.r, sourceH=100000-margins.t-margins.b
        const src=`<a:srcRect l="${Math.round(margins.l+sourceW*l)}" t="${Math.round(margins.t+sourceH*t)}" r="${Math.round(margins.r+sourceW*r)}" b="${Math.round(margins.b+sourceH*b)}"/>`
        let block=picture.replace(/<a:srcRect\b[^>]*(?:\/>|>[\s\S]*?<\/a:srcRect>)/,src)
        if(block===picture && !picture.includes('<a:srcRect')) block=block.replace('</a:blip>','</a:blip>'+src)
        block=block.replace(/(<p:cNvPr\b[^>]*\bid=")[^"]+"/,(_m,a:string)=>a+id+'"')
        block=block.replace(/(<a:xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\by=")[^"]+("[^>]*>)/,(_m,a:string,b:string)=>a+Math.round(y)+b)
        return block.replace(/(<a:xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\bx=")[^"]+("[^>]*>)/,(_m,a:string,b:string)=>a+Math.round(x)+b)
          .replace(/(<a:xfrm\b[^>]*>[\s\S]*?<a:ext\b[^>]*\bcx=")[^"]+("[^>]*\bcy=")[^"]+("[^>]*>)/,(_m,a:string,b:string,c:string)=>a+Math.max(1,Math.round(w))+b+Math.max(1,Math.round(h))+c)
      }
      if(request.effect==='wipe-down') moved=crop(0,0,0,1-progress,Number(off.x),Number(ext.cx),Number(ext.cy)*progress,request.shapeId)
      else if(request.effect==='wipe-up') moved=crop(0,1-progress,0,0,Number(off.x),Number(ext.cx),Number(ext.cy)*progress,request.shapeId,Number(off.y)+Number(ext.cy)*(1-progress))
      else moved=crop(0,0,1-progress/2,0,Number(off.x),Number(ext.cx)*progress/2,Number(ext.cy),request.shapeId)+crop(1-progress/2,0,0,0,Number(off.x)+Number(ext.cx)*(1-progress/2),Number(ext.cx)*progress/2,Number(ext.cy),'200000')
    }
    return { path: request.slidePath, xml: xml.replace(picture, moved) }
  })
  return frameDeck(data, pages)
}

function frameDeck(data: Buffer, pages: Array<{ path: string; xml: string }>, foreground = false): Buffer {
  const entries = parseZip(data)
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  const read = (name: string): string => {
    const entry = byName.get(name)
    if (!entry) throw new Error(`Missing native frame part: ${name}`)
    return readEntry(data, entry).toString('utf8')
  }
  const omitRelationships = (xml: string, types: string[]): string =>
    xml.replace(/<Relationship\b[^>]*\/>/g, tag => types.includes(attrsOf(tag).Type?.split('/').pop() ?? '') ? '' : tag)
  let relationships = read('ppt/_rels/presentation.xml.rels')
  if (foreground) relationships = omitRelationships(relationships, ['slide'])
  let types = read('[Content_Types].xml')
  const slides: string[] = []
  const add: ZipMods['add'] = []
  pages.forEach((page, index) => {
    const name = `_cuedeck_frame_${index}.xml`
    const path = `ppt/slides/${name}`
    const rid = `rIdCuedeckFrame${index}`
    if (byName.has(path)) throw new Error('Native frame name collision')
    add.push({ name: path, data: Buffer.from(page.xml) })
    const pageRels = read(relsPathOf(page.path))
    add.push({ name: relsPathOf(path), data: Buffer.from(foreground
      ? omitRelationships(pageRels, ['slide', 'notesSlide', 'audio', 'video', 'media', 'hyperlink'])
      : pageRels) })
    slides.push(`<p:sldId id="${10000 + index}" r:id="${rid}"/>`)
    relationships = relationships.replace('</Relationships>', `<Relationship Id="${rid}" Type="${SLIDE_REL_TYPE}" Target="slides/${name}"/></Relationships>`)
    types = types.replace('</Types>', `<Override PartName="/${path}" ContentType="${SLIDE_CONTENT_TYPE}"/></Types>`)
  })
  const presentation=read('ppt/presentation.xml').replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,'<p:sldIdLst>'+slides.join('')+'</p:sldIdLst>')
  const replace = new Map([
    ['ppt/presentation.xml', Buffer.from(presentation)],
    ['ppt/_rels/presentation.xml.rels', Buffer.from(relationships)],
    ['[Content_Types].xml', Buffer.from(types)],
  ])
  if (!foreground) return rebuildZip(data, entries, { strip: new Set(), replace, add })

  // Rebuild the foreground deck from its OPC relationships so unrelated slides
  // and their large embedded movies never reach the second PowerPoint export.
  const added = new Map(add.map(entry => [entry.name, entry.data]))
  const reachable = new Set<string>(['[Content_Types].xml'])
  const visit = (part: string): void => {
    if (reachable.has(part)) return
    reachable.add(part)
    const rels = part ? relsPathOf(part) : '_rels/.rels'
    const entry = added.get(rels) ?? replace.get(rels) ?? (byName.has(rels) ? readEntry(data, byName.get(rels)!) : undefined)
    if (!entry) return
    reachable.add(rels)
    for (const tag of entry.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
      const { Target, TargetMode } = attrsOf(tag[0])
      if (!Target || TargetMode === 'External') continue
      const path = Target.startsWith('/') ? Target.slice(1) : posix.join(posix.dirname(part), Target)
      visit(decodeXml(path))
    }
  }
  visit('')
  // Minimal synthetic PPTX fixtures may omit the package relationship to presentation.xml.
  visit('ppt/presentation.xml')
  types = types.replace(/<Override\b[^>]*\/>/g, tag =>
    reachable.has(attrsOf(tag).PartName?.slice(1)) ? tag : '')
  replace.set('[Content_Types].xml', Buffer.from(types))
  return rebuildZip(data, entries.filter(entry => reachable.has(entry.name)),
    { strip: new Set(), replace, add: add.filter(entry => reachable.has(entry.name)) })
}

// ── Публичный вход ───────────────────────────────────────────────────────────

/**
 * Манифест из кэша. `current` — нашей версии, им можно пользоваться как есть;
 * `pdfValid` — PDF в кэше собран от той же пересборки (старая версия
 * манифеста без заметок), пересоздавать его не нужно.
 */
async function readManifest(
  sha1: string,
  roots: PptxMediaRoots,
  renderer: 'libreoffice' | 'powerpoint' = 'libreoffice',
): Promise<{ current: MediaManifest | null; pdfValid: boolean }> {
  try {
    const raw = await readFile(manifestPathFor(sha1, roots), 'utf8')
    const parsed = JSON.parse(raw) as MediaManifest
    if ((parsed.renderer ?? 'libreoffice') !== renderer) return { current: null, pdfValid: false }
    if (!Array.isArray(parsed.slideMedia)) return { current: null, pdfValid: false }
    const current =
      isCurrentPptxManifest(parsed) &&
      parsed.pageNotes &&
      typeof parsed.pageNotes === 'object' &&
      Array.isArray(parsed.fonts)
        ? parsed
        : null
    return { current, pdfValid: COMPATIBLE_PDF_VERSIONS.has(parsed.version) }
  } catch {
    return { current: null, pdfValid: false }
  }
}

/** Прогнать трансформацию и положить пересобранную копию в кэш; вернуть её путь. */
async function writeRebuilt(sha1: string, zip: Buffer, roots: PptxMediaRoots): Promise<string> {
  const out = join(roots.writeDir, `${sha1}.rebuilt.pptx`)
  await mkdir(roots.writeDir, { recursive: true })
  await writeFile(out, zip)
  return out
}

/**
 * Подготовка PPTX перед конверсией: manifest + извлечённые ролики в кэше, и
 * выбор источника для LibreOffice (пересобранная копия — без видеофайлов и с
 * развёрнутыми шаг-страницами анимаций). Любая ошибка разбора → деградация к
 * старому поведению (конвертируем оригинал, без оверлеев и шагов).
 */
export async function preparePptxMedia(
  pptxPath: string,
  sha1: string,
  rootsOverride?: PptxMediaRoots,
  renderer: 'libreoffice' | 'powerpoint' = 'libreoffice',
): Promise<PreparedPptxMedia> {
  const original: PreparedPptxMedia = {
    slideMedia: [],
    pageNotes: {},
    fonts: [],
    convertSource: pptxPath,
    temporary: false,
  }
  // Парсим только настоящие .pptx: ppt — OLE-бинарь, odp/key — другой XML.
  if (extOf(pptxPath) !== 'pptx') return original

  const roots = await resolveRoots(rootsOverride)
  try {
    const { current: cached, pdfValid } = await readManifest(sha1, roots, renderer)
    if (cached) {
      const fromCache = {
        ...original,
        slideMedia: cached.slideMedia,
        slideTransitions: cached.slideTransitions ?? {},
        slideNumbering: cached.slideNumbering,
        slideBuilds: cached.slideBuilds ?? {},
        slideLinks: cached.slideLinks ?? {},
        slideKiosk: cached.slideKiosk === true,
        pageNotes: cached.pageNotes,
        fonts: cached.fonts,
      }
      if (!cached.rebuilt || existsSync(roots.pdfPath(sha1))) return fromCache
      // PDF из кэша пропал — пересобираем копию заново.
      const data = await readFile(pptxPath)
      const t = transformPptx(data, parseZip(data), renderer)
      if (!t.zip) return fromCache
      return {
        slideMedia: t.slideMedia,
        slideTransitions: t.slideTransitions ?? {},
        slideNumbering: t.slideNumbering,
        slideBuilds: t.slideBuilds ?? {},
        slideLinks: t.slideLinks ?? {},
        slideKiosk: t.slideKiosk === true,
        pageNotes: t.pageNotes,
        fonts: t.fonts,
        convertSource: await writeRebuilt(sha1, t.zip, roots),
        temporary: true,
      }
    }

    const data = await readFile(pptxPath)
    const entries = parseZip(data)
    const t = transformPptx(data, entries, renderer)

    // Извлечь ролики (для оверлеев), даже если пересборка не нужна.
    const mediaEntries = new Set([...t.videos.map(video => video.mediaEntry), ...(t.audioEntries ?? [])])
    if (mediaEntries.size > 0) {
      const dir = join(roots.writeDir, `${sha1}.media`)
      await mkdir(dir, { recursive: true })
      const byName = new Map(entries.map((e) => [e.name, e]))
      for (const entry of mediaEntries) {
        const file = mediaFileName(entry)
        await writeFile(join(dir, file), readEntry(data, byName.get(entry)!))
      }
    }

    await mkdir(roots.writeDir, { recursive: true })
    const manifest: MediaManifest = {
      version: MANIFEST_VERSION,
      renderer,
      rebuilt: t.zip !== null,
      slideMedia: t.slideMedia,
      slideTransitions: t.slideTransitions ?? {},
      slideNumbering: t.slideNumbering,
      slideBuilds: t.slideBuilds ?? {},
      slideLinks: t.slideLinks ?? {},
      slideKiosk: t.slideKiosk === true,
      pageNotes: t.pageNotes,
      fonts: t.fonts,
    }
    await writeFile(join(roots.writeDir, `${sha1}.media.json`), JSON.stringify(manifest))

    const nativeFrameSources: Array<{file:string;sourcePath:string}> = []
    for (const [file, request] of Object.entries(t.nativeFrames ?? {})) {
      const sourcePath = join(roots.writeDir, `${sha1}.${file}.pptx`)
      await writeFile(sourcePath, nativeFrameDeck(t.zip ?? data, request))
      nativeFrameSources.push({file,sourcePath})
    }
    if (t.foregroundPages?.length) {
      const file = 'video-foreground.pdf'
      const sourcePath = join(roots.writeDir, `${sha1}.${file}.pptx`)
      await writeFile(sourcePath, frameDeck(data, t.foregroundPages, true))
      nativeFrameSources.push({ file, sourcePath })
    }
    const parsed = { ...original, ...(nativeFrameSources.length ? {nativeFrameSources} : {}), slideMedia: t.slideMedia, slideTransitions: t.slideTransitions, slideNumbering: t.slideNumbering, slideBuilds: t.slideBuilds ?? {}, slideLinks: t.slideLinks ?? {}, slideKiosk: t.slideKiosk === true, pageNotes: t.pageNotes, fonts: t.fonts }
    if (!t.zip) return parsed
    // Манифест прошлой версии: PDF собран от такой же пересборки — годен.
    if (pdfValid && !t.requiresFreshPdf && existsSync(roots.pdfPath(sha1))) return parsed

    // PDF в кэше сделан до пересборки (без шагов, с видео внутри) — пересоздать.
    await rm(roots.pdfPath(sha1), { force: true }).catch(() => undefined)
    return { ...parsed, convertSource: await writeRebuilt(sha1, t.zip, roots), temporary: true }
  } catch (err) {
    if (renderer === 'powerpoint') throw err
    console.warn('[pptx-media] разбор не удался, конвертирую оригинал:', (err as Error).message)
    return original
  }
}

/** Read authored notes in show order without rewriting the PPTX for static PDF export. */
export async function staticPptxNotes(pptxPath: string): Promise<{ notes: Record<number, string>; visibleSlides: number; allSlides: number }> {
  const data = await readFile(pptxPath)
  const entries = new Map(parseZip(data).map((entry) => [entry.name, entry]))
  const text = (name: string): string | null => {
    const entry = entries.get(name)
    return entry ? readEntry(data, entry).toString('utf8') : null
  }
  const pres = parsePresentation(text)
  if (!pres) throw new Error('Cannot read PPTX slide order')
  const notes: Record<number, string> = {}
  let page = 0
  pres.slidePaths.forEach((path, index) => {
    const note = slideNotesText(path, text)
    if (pres.hidden.has(index)) return
    page++
    if (note) notes[page] = note
  })
  return { notes, visibleSlides: page, allSlides: pres.slidePaths.length }
}
