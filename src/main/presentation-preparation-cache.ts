import type { SlideBuildAnimation } from '../shared/types.js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  PREPARED_CACHE_FOLDER,
  PREPARED_METADATA_FILE,
  PREPARED_METADATA_VERSION,
  PREPARED_VERSION_PREFIX,
  identityKey,
  type PreparedCacheMetadata,
  type PreparedPresentation,
  type SourceIdentity,
} from '../shared/presentation-preparation.js'
import { PPTX_MANIFEST_VERSION } from '../shared/presentation-preparation.js'

/**
 * Versioned-кэш готовой подготовки. Один job пишет в приватный stage; main
 * публикует его одним rename целой папки в <cacheRoot>/prepared/<sha>/v-<gen>.
 * Старые versioned-root не перезаписываются: живые деки продолжают читать свой
 * root, пока не откроют новый.
 */

interface IndexLocator {
  sha1: string
  generation: number
  sourcePath: string
  identity: SourceIdentity
  createdAt: number
}

interface CacheIndex {
  version: number
  entries: IndexLocator[]
}

export interface PublishInput {
  artifactsDir: string
  sha1: string
  sourceSha1?: string
  backend?: 'libreoffice' | 'powerpoint-static'
  generation: number
  sourcePath: string
  identity: SourceIdentity
  totalSlides: number
  slideMedia: PreparedPresentation['slideMedia']
  slideTransitions?: Record<number, number>
  slideBuilds?: Record<number, SlideBuildAnimation>
  pageNotes: Record<number, string>
  fonts: string[]
  hasManifest: boolean
  /** Проверка перед атомарным rename: force/cancel не должен опубликовать stale. */
  commitGuard?: () => boolean
}

export interface PresentationCacheOptions {
  /** userData/pptx-cache; versioned-roots лежат в <root>/prepared. */
  cacheRoot: string
  registerRoot?: (sha1: string, root: string) => void
  log?: (level: 'warn' | 'error', message: string, error?: unknown) => void
}

const INDEX_VERSION = 1

export function versionName(generation: number): string {
  return `${PREPARED_VERSION_PREFIX}${String(generation).padStart(16, '0')}`
}

function generationOf(name: string): number | null {
  if (!name.startsWith(PREPARED_VERSION_PREFIX)) return null
  const value = Number(name.slice(PREPARED_VERSION_PREFIX.length))
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function identityOf(value: unknown): SourceIdentity | null {
  if (!value || typeof value !== 'object') return null
  const identity = value as SourceIdentity
  return typeof identity.dev === 'string' && typeof identity.ino === 'string' &&
    typeof identity.size === 'string' && typeof identity.mtimeNs === 'string' &&
    typeof identity.ctimeNs === 'string' ? identity : null
}

export class PresentationCache {
  readonly preparedRoot: string
  readonly stageRoot: string
  private readonly indexPath: string
  private readonly registerRoot: (sha1: string, root: string) => void
  private readonly log: (level: 'warn' | 'error', message: string, error?: unknown) => void
  private index: CacheIndex | null = null
  private rebuilt = false
  private bySha = new Map<string, IndexLocator>()
  private byPath = new Map<string, IndexLocator>()
  private stageCleanup: Promise<void> | null = null

  constructor(options: PresentationCacheOptions) {
    this.preparedRoot = join(options.cacheRoot, PREPARED_CACHE_FOLDER)
    this.stageRoot = join(options.cacheRoot, '.prep-stage')
    this.indexPath = join(this.preparedRoot, 'index.json')
    this.registerRoot = options.registerRoot ?? (() => undefined)
    this.log = options.log ?? (() => undefined)
  }

  private reindex(entries: IndexLocator[]): void {
    this.index = { version: INDEX_VERSION, entries }
    this.bySha.clear()
    this.byPath.clear()
    for (const entry of entries) {
      const current = this.bySha.get(entry.sha1)
      if (!current || current.generation < entry.generation) this.bySha.set(entry.sha1, entry)
      const key = `${resolve(entry.sourcePath)}\0${identityKey(entry.identity)}`
      const previous = this.byPath.get(key)
      if (!previous || previous.generation < entry.generation) this.byPath.set(key, entry)
    }
  }

  private async ensureIndex(): Promise<void> {
    if (this.index) return
    if (!this.stageCleanup) {
      this.stageCleanup = this.cleanupStages().catch((error) => {
        this.log('warn', 'preparation: failed to clean old stages', error) // i18n-ok: worker/main error
      })
    }
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as Partial<CacheIndex>
      if (parsed.version === INDEX_VERSION && Array.isArray(parsed.entries)) {
        const entries: IndexLocator[] = []
        for (const raw of parsed.entries) {
          if (!raw || typeof raw !== 'object') continue
          const entry = raw as Partial<IndexLocator>
          const identity = identityOf(entry.identity)
          if (typeof entry.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(entry.sha1) ||
              !Number.isSafeInteger(entry.generation) || (entry.generation ?? 0) <= 0 ||
              typeof entry.sourcePath !== 'string' || !identity) continue
          entries.push({
            sha1: entry.sha1,
            generation: entry.generation!,
            sourcePath: entry.sourcePath,
            identity,
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          })
        }
        this.reindex(entries)
        return
      }
    } catch {
      // Нет/битый index — восстановим по каталогам.
    }
    await this.rebuildFromDisk()
  }

  private async rebuildFromDisk(): Promise<void> {
    this.rebuilt = true
    const entries: IndexLocator[] = []
    let shas: string[] = []
    try {
      shas = (await readdir(this.preparedRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name))
        .map((entry) => entry.name)
    } catch {
      this.reindex([])
      return
    }
    for (const sha1 of shas) {
      let versions: string[] = []
      try {
        versions = (await readdir(join(this.preparedRoot, sha1), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && generationOf(entry.name) !== null)
          .map((entry) => entry.name)
          .sort((a, b) => (generationOf(b) ?? 0) - (generationOf(a) ?? 0))
      } catch { continue }
      for (const name of versions) {
        const meta = await this.readMetadataAt(join(this.preparedRoot, sha1, name))
        if (!meta || meta.sha1 !== sha1 || versionName(meta.generation) !== name) continue
        entries.push({
          sha1,
          generation: meta.generation,
          sourcePath: meta.sourcePath,
          identity: meta.identity,
          createdAt: meta.createdAt,
        })
      }
    }
    this.reindex(entries)
    await this.writeIndex()
  }

  private async writeIndex(): Promise<void> {
    const payload: CacheIndex = { version: INDEX_VERSION, entries: this.index?.entries ?? [] }
    const tmp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(this.preparedRoot, { recursive: true })
      await writeFile(tmp, JSON.stringify(payload), 'utf8')
      await rename(tmp, this.indexPath)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      this.log('warn', 'preparation: failed to write index', error) // i18n-ok: worker/main error
    }
  }

  private async readMetadataAt(root: string): Promise<PreparedCacheMetadata | null> {
    try {
      const raw = JSON.parse(await readFile(join(root, PREPARED_METADATA_FILE), 'utf8')) as PreparedCacheMetadata
      if (raw.version !== PREPARED_METADATA_VERSION || typeof raw.sha1 !== 'string' ||
          !/^[a-f0-9]{40}$/.test(raw.sha1) || !Number.isSafeInteger(raw.generation) ||
          typeof raw.sourcePath !== 'string' || !identityOf(raw.identity) ||
          !Number.isFinite(raw.totalSlides) || !Array.isArray(raw.fonts) ||
          !Array.isArray(raw.slideMedia) || !raw.pageNotes || typeof raw.pageNotes !== 'object') return null
      return raw
    } catch {
      return null
    }
  }

  /** Полная проверка root: PDF, manifest v7 и все media-файлы. */
  async validRoot(sha1: string, generation: number): Promise<{ meta: PreparedCacheMetadata; pdfPath: string } | null> {
    const root = join(this.preparedRoot, sha1, versionName(generation))
    const meta = await this.readMetadataAt(root)
    if (!meta || meta.sha1 !== sha1 || meta.generation !== generation) return null
    const pdfPath = join(root, `${sha1}.pdf`)
    const pdf = await stat(pdfPath).catch(() => null)
    if (!pdf?.isFile() || pdf.size === 0) return null
    if (meta.hasManifest) {
      try {
        const manifest = JSON.parse(await readFile(join(root, `${sha1}.media.json`), 'utf8'))
        if (manifest.version !== PPTX_MANIFEST_VERSION || typeof manifest.rebuilt !== 'boolean' ||
            !Array.isArray(manifest.slideMedia) || !manifest.pageNotes ||
            typeof manifest.pageNotes !== 'object' || Array.isArray(manifest.pageNotes) ||
            !Object.values(manifest.pageNotes).every((note) => typeof note === 'string')) return null
        for (const media of manifest.slideMedia) {
          if (!media || typeof media.file !== 'string' || !media.file || /[/\\\0]/.test(media.file) ||
              !Number.isInteger(media.slide) || media.slide < 1 ||
              !media.rect || !['x', 'y', 'w', 'h'].every((key: string) => Number.isFinite(media.rect[key]))) return null
          const file = await stat(join(root, `${sha1}.media`, media.file)).catch(() => null)
          if (!file?.isFile()) return null
        }
      } catch {
        return null
      }
    }
    return { meta, pdfPath }
  }

  private resultOf(meta: PreparedCacheMetadata, pdfPath: string): PreparedPresentation {
    return {
      sha1: meta.sha1,
      sourceSha1: meta.sourceSha1,
      totalSlides: meta.totalSlides,
      slideMedia: meta.slideMedia,
      slideTransitions: meta.slideTransitions ?? {},
      slideBuilds: meta.slideBuilds ?? {},
      pageNotes: meta.pageNotes,
      fonts: meta.fonts,
      pdfPath,
      cacheRoot: dirname(pdfPath),
    }
  }

  async lookupByIdentity(filePath: string, identity: SourceIdentity, backend: 'libreoffice' | 'powerpoint-static' = 'libreoffice'): Promise<PreparedPresentation | null> {
    await this.ensureIndex()
    const key = `${resolve(filePath)}\0${identityKey(identity)}`
    let locator = this.byPath.get(key)
    if (!locator && !this.rebuilt) {
      await this.rebuildFromDisk()
      locator = this.byPath.get(key)
    }
    if (!locator) return null
    const valid = await this.validRoot(locator.sha1, locator.generation)
    if (!valid || (valid.meta.backend ?? 'libreoffice') !== backend) {
      this.byPath.delete(key)
      return null
    }
    this.registerRoot(locator.sha1, dirname(valid.pdfPath))
    return this.resultOf(valid.meta, valid.pdfPath)
  }

  async lookupBySha(sha1: string): Promise<PreparedPresentation | null> {
    await this.ensureIndex()
    let locator = this.bySha.get(sha1)
    if (!locator && !this.rebuilt) {
      await this.rebuildFromDisk()
      locator = this.bySha.get(sha1)
    }
    if (!locator) return null
    const valid = await this.validRoot(sha1, locator.generation)
    if (!valid) return null
    this.registerRoot(sha1, dirname(valid.pdfPath))
    return this.resultOf(valid.meta, valid.pdfPath)
  }

  /**
   * Запомнить дополнительный путь/stat для уже готового локального root.
   * Так повторное открытие копии того же файла не идёт в worker за hash.
   */
  async rememberPath(filePath: string, identity: SourceIdentity, result: PreparedPresentation): Promise<void> {
    const prefix = this.preparedRoot + sep
    if (!result.cacheRoot.startsWith(prefix)) return
    const generation = generationOf(basename(result.cacheRoot))
    if (generation === null) return
    await this.ensureIndex()
    const locator: IndexLocator = {
      sha1: result.sha1,
      generation,
      sourcePath: filePath,
      identity,
      createdAt: Date.now(),
    }
    const key = `${resolve(filePath)}\0${identityKey(identity)}`
    const entries = (this.index?.entries ?? []).filter((entry) =>
      `${resolve(entry.sourcePath)}\0${identityKey(entry.identity)}` !== key)
    entries.push(locator)
    this.reindex(entries)
    await this.writeIndex()
  }

  async stageDir(jobId: string): Promise<string> {
    await mkdir(this.stageRoot, { recursive: true })
    const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'job'
    const stage = await mkdtemp(join(this.stageRoot, `${safe}-`))
    await writeFile(join(stage, '.cuedeck-preparation-stage'), JSON.stringify({ version: 1, jobId: safe }))
    return stage
  }

  async discardStage(stageDir: string | null): Promise<void> {
    if (!stageDir) return
    await rm(stageDir, { recursive: true, force: true }).catch((error) => {
      this.log('warn', `preparation: failed to remove stage ${stageDir}`, error) // i18n-ok: worker/main error
    })
  }

  /**
   * Публикация: metadata пишется в stage, затем вся папка artifacts
   * переименовывается в versioned-root. Многофайлового rename нет.
   */
  async publish(input: PublishInput): Promise<PreparedPresentation> {
    const metadata: PreparedCacheMetadata = {
      version: PREPARED_METADATA_VERSION,
      sha1: input.sha1,
      sourceSha1: input.sourceSha1,
      backend: input.backend,
      generation: input.generation,
      sourcePath: input.sourcePath,
      identity: input.identity,
      totalSlides: input.totalSlides,
      fonts: input.fonts,
      slideMedia: input.slideMedia,
      slideTransitions: input.slideTransitions ?? {},
      slideBuilds: input.slideBuilds ?? {},
      pageNotes: input.pageNotes,
      hasManifest: input.hasManifest,
      createdAt: Date.now(),
    }
    const metadataTmp = join(input.artifactsDir, `${PREPARED_METADATA_FILE}.tmp-${process.pid}`)
    await writeFile(metadataTmp, JSON.stringify(metadata), 'utf8')
    await rename(metadataTmp, join(input.artifactsDir, PREPARED_METADATA_FILE))

    const versionRoot = join(this.preparedRoot, input.sha1, versionName(input.generation))
    await mkdir(dirname(versionRoot), { recursive: true })
    if (existsSync(versionRoot)) throw new Error(`preparation: generation already exists: ${versionRoot}`)
    if (input.commitGuard && !input.commitGuard()) throw new Error('preparation: stale generation')
    await rename(input.artifactsDir, versionRoot)
    // Main-side повторная проверка уже опубликованной целой папки: если
    // очистка кэша успела её убрать, не отдаём битый результат.
    if (!(await this.validRoot(input.sha1, input.generation))) {
      await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('preparation: published root failed validation')
    }
    this.registerRoot(input.sha1, versionRoot)

    await this.ensureIndex()
    const locator: IndexLocator = {
      sha1: input.sha1,
      generation: input.generation,
      sourcePath: input.sourcePath,
      identity: input.identity,
      createdAt: metadata.createdAt,
    }
    const entries = (this.index?.entries ?? []).filter((entry) => entry.sha1 !== input.sha1)
    entries.push(locator)
    this.reindex(entries)
    await this.writeIndex()
    const pdfPath = join(versionRoot, `${input.sha1}.pdf`)
    return this.resultOf(metadata, pdfPath)
  }

  /** Старые незавершённые stage после падения. Новые не трогаем: возраст > 24 ч. */
  async cleanupStages(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    let entries
    try {
      entries = await readdir(this.stageRoot, { withFileTypes: true })
    } catch {
      return
    }
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(this.stageRoot, entry.name)
      try {
        const marker = JSON.parse(await readFile(join(path, '.cuedeck-preparation-stage'), 'utf8'))
        if (marker.version !== 1 || typeof marker.jobId !== 'string' || !entry.name.startsWith(`${marker.jobId}-`)) continue
      } catch { continue }
      const info = await stat(path).catch(() => null)
      if (info && now - info.mtimeMs > maxAgeMs) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
