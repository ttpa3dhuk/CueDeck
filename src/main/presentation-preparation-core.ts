import { validSlideAudioCue } from '../shared/slide-video.js'
import type { SlideBuildAnimation } from '../shared/types.js'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { sourceIdentity } from './presentation-source-identity.js'
export { sourceIdentity } from './presentation-source-identity.js'
import { dirname, extname, join } from 'node:path'
import { countPdfPages } from './pdf-pages.js'
import { preparePptxMedia, staticPptxNotes, type PptxMediaRoots } from './pptx-media.js'
import { exportPowerpointStatic } from './powerpoint-static.js'
import { substitutedFonts } from './pptx-fonts.js'
import { convertSourceToPdf, type ConvertToPdfOptions } from './presentation-preparation-convert.js'
import {
  PPTX_MANIFEST_VERSION,
  sameIdentity,
  type PreparationErrorCode,
  type PreparationWorkerResult,
  type SourceIdentity,
  type PresentationBackend,
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
  sourceSha1?: string
  artifactsDir: string
  identity: SourceIdentity
  hasManifest: boolean
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
  slideTransitions?: Record<number, import('../shared/pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('../shared/types.js').SlideVideoLink[]>
  slideKiosk?: boolean
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
    slideTransitions?: Record<number, import('../shared/pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('../shared/types.js').SlideVideoLink[]>
  slideKiosk?: boolean
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
  const foregroundCounts = new Map<string, number>()
  for (const media of manifest.slideMedia as SlideMedia[]) {
    if (!media || typeof media.file !== 'string' || !media.file ||
        /[/\\\0]/.test(media.file) || media.file === '.' || media.file === '..' ||
        !Number.isInteger(media.slide) || media.slide < 1 ||
        !media.rect || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite((media.rect as unknown as Record<string, unknown>)[key]))) {
      throw new PreparationFailure('invalid_cache', 'Unsafe media filename', 'validate') // i18n-ok: worker/main error
    }
    const file = await stat(join(mediaDir, media.file)).catch(() => null)
    if (!file?.isFile()) throw new PreparationFailure('invalid_cache', `Missing media ${media.file}`, 'validate') // i18n-ok: worker/main error
    if (media.audio !== undefined && (!Array.isArray(media.audio) || !media.audio.every(validSlideAudioCue))) {
      throw new PreparationFailure('invalid_cache', 'Invalid slide audio cue', 'validate')
    }
    for (const cue of media.audio ?? []) {
      if (!(await stat(join(mediaDir, cue.file)).catch(() => null))?.isFile())
        throw new PreparationFailure('invalid_cache', 'Missing slide audio', 'validate')
    }
    if (media.interactive) {
      const { file, firstPage, layers, triggers } = media.interactive
      const rectOk = (rect: SlideMedia['rect']): boolean => Boolean(rect &&
        [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 &&
        rect.w > 0 && rect.h > 0 && rect.x + rect.w <= 1 && rect.y + rect.h <= 1)
      const shapeIds = new Set(layers?.map(layer => layer.shape).filter(Boolean))
      if (file !== 'video-foreground.pdf' || !Number.isInteger(firstPage) || firstPage < 1 ||
          !Array.isArray(layers) || !layers.length || layers.length > 25 ||
          !layers.every(layer => Number.isInteger(layer.page) && layer.page > firstPage && rectOk(layer.rect) &&
            (layer.shape === undefined || /^\d+$/.test(layer.shape))) ||
          !Array.isArray(triggers) || !triggers.length || triggers.length > 32 ||
          !triggers.every(trigger => /^\d+$/.test(trigger.id) && /^\d+$/.test(trigger.shape) && rectOk(trigger.rect) &&
            typeof trigger.label === 'string' && ['always', 'whenNotActive', 'never'].includes(trigger.restart) &&
            Number.isFinite(trigger.durationMs) && trigger.durationMs > 0 && trigger.durationMs <= 70_000 &&
            Array.isArray(trigger.effects) && trigger.effects.every(effect => shapeIds.has(effect.shape) &&
              [effect.startMs, effect.durationMs, effect.from?.x, effect.from?.y, effect.from?.opacity,
                effect.to?.x, effect.to?.y, effect.to?.opacity].every(Number.isFinite) && effect.startMs >= 0 && effect.durationMs > 0))) {
        throw new PreparationFailure('invalid_cache', 'Invalid interactive PPTX scene', 'validate')
      }
      foregroundCounts.set(file, Math.max(foregroundCounts.get(file) ?? 0, ...layers.map(layer => layer.page + 1)))
    }
    if (media.foreground) {
      const foreground = media.foreground
      const { file, firstPage } = foreground
      const validRect = (rect: SlideMedia['rect'] | undefined): boolean => Boolean(rect &&
        [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) &&
        rect.x >= 0 && rect.y >= 0 && rect.w > 0 && rect.h > 0 && rect.x + rect.w <= 1 && rect.y + rect.h <= 1)
      const validLink = (link: import('../shared/types.js').SlideVideoLink | undefined): boolean =>
        Boolean(link && Number.isInteger(link.slide) && link.slide > 0 && validRect(link.rect))
      const valid = foreground.kind === 'menu'
        ? validRect(foreground.button) && Array.isArray(foreground.links) && foreground.links.every(validLink) &&
          (foreground.buttonDelayMs === undefined || Number.isInteger(foreground.buttonDelayMs) &&
            foreground.buttonDelayMs > 0 && foreground.buttonDelayMs <= 60_000)
        : foreground.kind === 'return' ? validLink(foreground.link)
        : foreground.kind === 'static' && Array.isArray(foreground.links) && foreground.links.every(validLink)
      if (file !== 'video-foreground.pdf' || !Number.isInteger(firstPage) || firstPage < 1 || !valid) {
        throw new PreparationFailure('invalid_cache', 'Invalid slide video foreground', 'validate')
      }
      const lastPage = firstPage + (foreground.kind === 'menu' ? (foreground.buttonDelayMs ? 5 : 3) : 1)
      let maxPage = lastPage
      const validStep = (step: import('../shared/types.js').SlideForegroundStep): boolean =>
        Boolean(step && [step.startMs, step.durationMs, step.from?.x, step.from?.y,
          step.from?.opacity, step.to?.x, step.to?.y, step.to?.opacity].every(Number.isFinite) &&
          step.startMs >= 0 && step.durationMs > 0 && step.durationMs <= 60_000)
      for (const motion of [foreground.motion?.entry, foreground.motion?.menu]) {
        if (!motion) continue
        if (!Number.isInteger(motion.basePage) || motion.basePage < 1 ||
            !Array.isArray(motion.actors) || !motion.actors.length || motion.actors.length > 16 ||
            !motion.actors.every(actor => Number.isInteger(actor.page) && actor.page > 0 && validRect(actor.rect) &&
              [actor.pivot?.x, actor.pivot?.y].every(Number.isFinite) && validStep(actor) &&
              (actor.following === undefined || Array.isArray(actor.following) && actor.following.every(validStep)))) {
          throw new PreparationFailure('invalid_cache', 'Invalid foreground motion', 'validate')
        }
        maxPage = Math.max(maxPage, motion.basePage + 1, ...motion.actors.map(actor => actor.page + 1))
      }
      foregroundCounts.set(file, Math.max(foregroundCounts.get(file) ?? 0, maxPage))
    }
  }
  for (const [file, count] of foregroundCounts) {
    if (countPdfPages(await readFile(join(mediaDir, file))) !== count)
      throw new PreparationFailure('invalid_cache', 'Slide video foreground page count mismatch', 'validate')
  }
  for (const build of Object.values(manifest.slideBuilds ?? {})) {
    if (!build.framesFile) continue
    if (typeof build.framesFile !== 'string' || /[/\\\0]/.test(build.framesFile) || build.framesFile === '.' || build.framesFile === '..') throw new PreparationFailure('invalid_cache','Unsafe animation filename','validate')
    const bytes=await readFile(join(mediaDir,build.framesFile))
    if(countPdfPages(bytes)!==build.frameCount) throw new PreparationFailure('invalid_cache','Animation frame count mismatch','validate')
  }
  return {
    hasManifest: true,
    slideMedia: manifest.slideMedia as SlideMedia[],
    slideTransitions: manifest.slideTransitions ?? {},
    slideBuilds: manifest.slideBuilds ?? {},
    slideLinks: manifest.slideLinks ?? {},
    slideKiosk: manifest.slideKiosk === true,
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
  backend?: PresentationBackend
  sourceSha1?: string
  log?: (message: string) => void
  /** Только для тестов: заменить запуск LibreOffice. */
  convert?: (options: ConvertToPdfOptions) => Promise<string>
  /** Test seam: no AppleEvents are sent by unit tests. */
  exportStatic?: typeof exportPowerpointStatic
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
  if (options.backend === 'powerpoint-static' && extension === '.pptx') {
    const prepared = await preparePptxMedia(stagedPath, sha1, rootsFor(artifactsDir), 'powerpoint')
    if (signal?.aborted) throw new PreparationFailure('cancelled', 'Preparation cancelled', 'parse')
    const { visibleSlides, allSlides } = await staticPptxNotes(prepared.convertSource)
    const exchangeDir = join(dirname(dirname(stageDir)), 'powerpoint-exchange')
    let pdfPath: string
    try {
      pdfPath = await (options.exportStatic ?? exportPowerpointStatic)(prepared.convertSource, artifactsDir, sha1, signal, exchangeDir)
    } finally {
      if (prepared.temporary) await rm(prepared.convertSource, { force: true }).catch(() => undefined)
    }
    for (const asset of prepared.nativeFrameSources ?? []) {
      const mediaDir=join(artifactsDir,`${sha1}.media`)
      await mkdir(mediaDir,{recursive:true})
      try {
        await (options.exportStatic ?? exportPowerpointStatic)(asset.sourcePath,mediaDir,asset.file.replace(/\.pdf$/,''),signal,exchangeDir)
      } finally { await rm(asset.sourcePath,{force:true}).catch(()=>undefined) }
    }
    const pages = countPdfPages(await readFile(pdfPath))
    if (pages !== visibleSlides) throw new PreparationFailure('io', `PowerPoint exported ${pages} pages for ${visibleSlides} visible (${allSlides} total) slides`, 'validate')
    const identityAfter = await sourceIdentity(originalPath)
    if (!sameIdentity(identityBefore, identityAfter)) throw new PreparationFailure('source_changed', 'Source changed during preparation', 'publish')
    const validated = await validateArtifacts(artifactsDir, sha1)
    return {
      sha1, sourceSha1: options.sourceSha1, totalSlides: pages,
      slideMedia: validated.slideMedia, slideTransitions: validated.slideTransitions, slideBuilds: validated.slideBuilds ?? {}, slideLinks: validated.slideLinks ?? {}, slideKiosk: validated.slideKiosk === true,
      pageNotes: prepared.pageNotes, fonts: [],
      artifactsDir, identity: identityAfter, hasManifest: validated.hasManifest,
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
    slideBuilds: validated.slideBuilds ?? {},
    slideLinks: validated.slideLinks ?? {},
    slideKiosk: validated.slideKiosk === true,
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
    slideBuilds: validated.slideBuilds ?? {},
    slideLinks: validated.slideLinks ?? {},
    slideKiosk: validated.slideKiosk === true,
    pageNotes: validated.pageNotes,
    fonts: substitutedFonts(validated.fonts, pdf),
    artifactsDir: cacheRoot,
    identity: identityAfter,
    hasManifest: validated.hasManifest,
  }
}
