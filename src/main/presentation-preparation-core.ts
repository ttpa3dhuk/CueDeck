import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { countPdfPages } from './pdf-pages.js'
import { preparePptxMedia, type PptxMediaRoots } from './pptx-media.js'
import { substitutedFonts } from './pptx-fonts.js'
import { convertSourceToPdf, type ConvertToPdfOptions } from './presentation-preparation-convert.js'
import {
  PPTX_MANIFEST_VERSION,
  sameIdentity,
  type PreparationErrorCode,
  type PreparationWorkerResult,
  type SourceIdentity,
} from '../shared/presentation-preparation.js'
import type { SlideMedia } from '../shared/types.js'

/**
 * Чистая (без Electron) часть подготовки. Выполняется в utilityProcess:
 * копия исходника + SHA1, OOXML-разбор preparePptxMedia (тот же алгоритм),
 * LibreOffice в приватный stage, подсчёт страниц PDF и проверка шрифтов.
 *
 * Main не читает сюда ни app.getPath, ни настройки, ни diag. Все пути,
 * soffice и язык переданы аргументами.
 */

export class PreparationFailure extends Error {
  constructor(
    readonly code: PreparationErrorCode,
    message: string,
    readonly phase?: string,
  ) {
    super(message)
    this.name = 'PreparationFailure'
  }
}

export interface StagedSource {
  stagedPath: string
  sha1: string
  identityBefore: SourceIdentity
  identityAfter: SourceIdentity
}

export interface StagedArtifacts extends PreparationWorkerResult {
  artifactsDir: string
  identity: SourceIdentity
  hasManifest: boolean
}

export async function sourceIdentity(filePath: string): Promise<SourceIdentity> {
  const info = await stat(filePath, { bigint: true })
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  }
}

function hashStream(sourcePath: string, targetPath: string): Promise<{ sha1: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    let bytes = 0
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const read = createReadStream(sourcePath)
    const write = createWriteStream(targetPath, { flags: 'wx' })
    read.on('data', (chunk: string | Buffer) => {
      hash.update(chunk)
      bytes += chunk.length
    })
    read.on('error', fail)
    write.on('error', fail)
    write.on('finish', () => {
      if (settled) return
      settled = true
      resolve({ sha1: hash.digest('hex'), bytes })
    })
    read.pipe(write)
  })
}

/** Приватная копия исходника в stage; SHA1 считается в том же проходе. */
export async function stageSourceCopy(sourcePath: string, stageDir: string, signal?: AbortSignal): Promise<StagedSource> {
  const identityBefore = await sourceIdentity(sourcePath)
  await mkdir(stageDir, { recursive: true })
  const extension = extname(sourcePath).toLowerCase()
  const stagedPath = join(stageDir, `source${extension || '.bin'}`)
  let copied: { sha1: string; bytes: number }
  try {
    copied = await hashStream(sourcePath, stagedPath)
  } catch (error) {
    throw new PreparationFailure('io', `Could not read source: ${String(error)}`, 'copy') // i18n-ok: worker/main error
  }
  if (signal?.aborted) throw new PreparationFailure('cancelled', 'Preparation cancelled', 'copy') // i18n-ok: worker/main error
  const identityAfter = await sourceIdentity(sourcePath)
  if (!sameIdentity(identityBefore, identityAfter) || copied.bytes !== Number(identityBefore.size)) {
    throw new PreparationFailure('source_changed', 'Source changed during preparation', 'copy') // i18n-ok: worker/main error
  }
  return { stagedPath, sha1: copied.sha1, identityBefore, identityAfter }
}

function rootsFor(artifactsDir: string): PptxMediaRoots {
  return {
    writeDir: artifactsDir,
    readDir: () => artifactsDir,
    pdfPath: (sha1) => join(artifactsDir, `${sha1}.pdf`),
  }
}

/** Проверка целостного набора: PDF, manifest v7 и все media-файлы. */
export async function validateArtifacts(artifactsDir: string, sha1: string): Promise<{
  hasManifest: boolean
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, number>
  pageNotes: Record<number, string>
  fonts: string[]
}> {
  const pdf = join(artifactsDir, `${sha1}.pdf`)
  const info = await stat(pdf).catch(() => null)
  if (!info?.isFile() || info.size === 0) throw new PreparationFailure('invalid_cache', 'PDF not created', 'validate') // i18n-ok: worker/main error
  const manifestPath = join(artifactsDir, `${sha1}.media.json`)
  if (!existsSync(manifestPath)) {
    return { hasManifest: false, slideMedia: [], pageNotes: {}, fonts: [] }
  }
  let manifest: {
    version?: unknown
    rebuilt?: unknown
    slideMedia?: unknown
    slideTransitions?: Record<number, number>
    pageNotes?: unknown
    fonts?: unknown
  }
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new PreparationFailure('invalid_cache', 'Cannot read manifest', 'validate') // i18n-ok: worker/main error
  }
  if (manifest.version !== PPTX_MANIFEST_VERSION || typeof manifest.rebuilt !== 'boolean' ||
      !Array.isArray(manifest.slideMedia) ||
      !Array.isArray(manifest.fonts) || !manifest.fonts.every((font) => typeof font === 'string') ||
      !manifest.pageNotes || typeof manifest.pageNotes !== 'object' || Array.isArray(manifest.pageNotes) ||
      !Object.values(manifest.pageNotes).every((note) => typeof note === 'string')) {
    throw new PreparationFailure('invalid_cache', 'Unsupported manifest version', 'validate') // i18n-ok: worker/main error
  }
  const mediaDir = join(artifactsDir, `${sha1}.media`)
  if (manifest.slideMedia.length && !(await stat(mediaDir).catch(() => null))?.isDirectory()) {
    throw new PreparationFailure('invalid_cache', 'Missing media directory', 'validate') // i18n-ok: worker/main error
  }
  for (const media of manifest.slideMedia as SlideMedia[]) {
    if (!media || typeof media.file !== 'string' || !media.file ||
        /[/\\\0]/.test(media.file) || media.file === '.' || media.file === '..' ||
        !Number.isInteger(media.slide) || media.slide < 1 ||
        !media.rect || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite((media.rect as unknown as Record<string, unknown>)[key]))) {
      throw new PreparationFailure('invalid_cache', 'Unsafe media filename', 'validate') // i18n-ok: worker/main error
    }
    const file = await stat(join(mediaDir, media.file)).catch(() => null)
    if (!file?.isFile()) throw new PreparationFailure('invalid_cache', `Missing media ${media.file}`, 'validate') // i18n-ok: worker/main error
  }
  return {
    hasManifest: true,
    slideMedia: manifest.slideMedia as SlideMedia[],
    slideTransitions: manifest.slideTransitions ?? {},
    pageNotes: manifest.pageNotes as Record<number, string>,
    fonts: manifest.fonts as string[],
  }
}

export interface PrepareArtifactsOptions {
  stagedPath: string
  originalPath: string
  sha1: string
  stageDir: string
  identityBefore: SourceIdentity
  sofficePath: string | null
  timeoutMs: number
  signal?: AbortSignal
  language?: 'ru' | 'en'
  log?: (message: string) => void
  /** Только для тестов: заменить запуск LibreOffice. */
  convert?: (options: ConvertToPdfOptions) => Promise<string>
}

/**
 * OOXML-разбор и экспорт PDF целиком внутри stage. Исходный файл не читается
 * повторно: работаем с приватной копией. В конце сверяем identity оригинала.
 */
export async function prepareStagedArtifacts(options: PrepareArtifactsOptions): Promise<StagedArtifacts> {
  const {
    stagedPath, originalPath, sha1, stageDir, identityBefore, sofficePath,
    timeoutMs, signal, log = () => undefined, convert = convertSourceToPdf,
  } = options
  const artifactsDir = join(stageDir, 'artifacts')
  const profileDir = join(stageDir, 'profile')
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(profileDir, { recursive: true })

  if (signal?.aborted) throw new PreparationFailure('cancelled', 'Preparation cancelled', 'parse') // i18n-ok: worker/main error
  const extension = extname(stagedPath).toLowerCase()
  if (extension === '.pdf') {
    // PDF уже готов: LibreOffice не нужен, но чтение/page count остаются в worker.
    const pdfPath = join(artifactsDir, `${sha1}.pdf`)
    await rename(stagedPath, pdfPath)
    const pdf = await readFile(pdfPath)
    const identityAfter = await sourceIdentity(originalPath)
    if (!sameIdentity(identityBefore, identityAfter)) {
      throw new PreparationFailure('source_changed', 'Source changed during preparation', 'publish') // i18n-ok: worker/main error
    }
    const validated = await validateArtifacts(artifactsDir, sha1)
    return {
      sha1,
      totalSlides: countPdfPages(pdf),
      slideMedia: [],
      pageNotes: {},
      fonts: [],
      artifactsDir,
      identity: identityAfter,
      hasManifest: validated.hasManifest,
    }
  }
  if (!['.pptx', '.ppt', '.odp', '.key'].includes(extension)) {
    throw new PreparationFailure('io', 'Неподдерживаемый формат презентации', 'parse') // i18n-ok: worker/main error
  }
  if (extname(originalPath).toLowerCase() === '.pptx') {
    const file = await open(stagedPath, 'r')
    const header = Buffer.alloc(4)
    try { await file.read(header, 0, header.length, 0) }
    finally { await file.close() }
    if (header.readUInt32LE() !== 0x04034b50) {
      throw new PreparationFailure('invalid_archive', 'PPTX is not an OOXML ZIP archive', 'parse')
    }
  }
  log(`pptx-media: parsing ${stagedPath}`) // i18n-ok: worker/main error
  const prepared = await preparePptxMedia(stagedPath, sha1, rootsFor(artifactsDir))
  if (signal?.aborted) throw new PreparationFailure('cancelled', 'Preparation cancelled', 'parse') // i18n-ok: worker/main error

  let generated: string
  try {
    generated = await convert({
      sofficePath,
      sourcePath: prepared.convertSource,
      outputDir: artifactsDir,
      profileDir,
      timeoutMs,
      signal,
      log: (level, message, error) => log(`soffice[${level}]: ${message}${error ? ` ${String(error)}` : ''}`),
    })
  } finally {
    if (prepared.temporary) await rm(prepared.convertSource, { force: true }).catch(() => undefined)
  }
  const pdfPath = join(artifactsDir, `${sha1}.pdf`)
  if (generated !== pdfPath) await rename(generated, pdfPath)

  const pdf = await readFile(pdfPath)
  const totalSlides = countPdfPages(pdf)
  let validated = await validateArtifacts(artifactsDir, sha1)
  // Деградация разбора: конвертировали оригинал. Manifest v7 с пустыми
  // оверлеями сохраняет экспорт/перенос проекта рабочим и не врёт о страницах.
  if (!validated.hasManifest && extname(stagedPath).toLowerCase() === '.pptx') {
    await writeFile(join(artifactsDir, `${sha1}.media.json`), JSON.stringify({
      version: PPTX_MANIFEST_VERSION,
      rebuilt: false,
      slideMedia: [],
      pageNotes: {},
      fonts: prepared.fonts,
    }))
    validated = await validateArtifacts(artifactsDir, sha1)
  }
  const fonts = substitutedFonts(validated.fonts.length ? validated.fonts : prepared.fonts, pdf)
  // Пересобранная копия не должна попасть в опубликованный кэш и учитываться в stats.
  await rm(join(artifactsDir, `${sha1}.rebuilt.pptx`), { force: true }).catch(() => undefined)

  const identityAfter = await sourceIdentity(originalPath)
  if (!sameIdentity(identityBefore, identityAfter)) {
    throw new PreparationFailure('source_changed', 'Source changed during preparation', 'publish') // i18n-ok: worker/main error
  }
  return {
    sha1,
    totalSlides,
    slideMedia: validated.slideMedia,
    slideTransitions: validated.slideTransitions ?? {},
    pageNotes: validated.pageNotes,
    fonts,
    artifactsDir,
    identity: identityAfter,
    hasManifest: validated.hasManifest,
  }
}

export interface InspectCacheOptions {
  cacheRoot: string
  pdfPath: string
  sha1: string
  originalPath: string
  identityBefore: SourceIdentity
  signal?: AbortSignal
}

/** Готовый project-cache: только прочитать manifest/PDF и пересчитать страницы. */
export async function inspectCachedArtifacts(options: InspectCacheOptions): Promise<StagedArtifacts> {
  const { cacheRoot, pdfPath, sha1, originalPath, identityBefore, signal } = options
  if (signal?.aborted) throw new PreparationFailure('cancelled', 'Preparation cancelled', 'cache') // i18n-ok: worker/main error
  const validated = await validateArtifacts(cacheRoot, sha1)
  const pdf = await readFile(pdfPath)
  const identityAfter = await sourceIdentity(originalPath)
  if (!sameIdentity(identityBefore, identityAfter)) {
    throw new PreparationFailure('source_changed', 'Source changed during preparation', 'cache') // i18n-ok: worker/main error
  }
  return {
    sha1,
    totalSlides: countPdfPages(pdf),
    slideMedia: validated.slideMedia,
    slideTransitions: validated.slideTransitions ?? {},
    pageNotes: validated.pageNotes,
    fonts: substitutedFonts(validated.fonts, pdf),
    artifactsDir: cacheRoot,
    identity: identityAfter,
    hasManifest: validated.hasManifest,
  }
}
