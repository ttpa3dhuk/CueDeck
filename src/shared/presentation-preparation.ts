import type { SlideBuildAnimation } from './types.js'
/**
 * Контракт фоновой подготовки презентаций. Общий модуль main/worker: здесь
 * только типы, коды ошибок и имена файлов кэша — без Electron, fs и i18n,
 * чтобы worker не тянул состояние приложения.
 */
import type { PlaylistEntry, SlideMedia } from './types.js'

/** Версия OOXML-манифеста (pptx-media). Формат уже используется проектами. */
export const PPTX_MANIFEST_VERSION = 12

export function isCurrentPptxManifest(manifest: { version?: unknown; renderer?: unknown }): boolean {
  // v11 PowerPoint manifests already contain the embedded audio cues.
  return manifest.version === PPTX_MANIFEST_VERSION || manifest.version === 11 && manifest.renderer === 'powerpoint'
}

/** Папка versioned-кэша внутри userData/pptx-cache. */
export const PREPARED_CACHE_FOLDER = 'prepared'
/** Файл метаданных внутри одного versioned-root. */
export const PREPARED_METADATA_FILE = 'prepared.json'
export const PREPARED_METADATA_VERSION = 2
/** Префикс имени versioned-root: v-<generation>. */
export const PREPARED_VERSION_PREFIX = 'v-'

export type PreparationPriority = 'foreground' | 'background'
export type PresentationBackend = 'libreoffice' | 'powerpoint-static'
export function isPresentationBackend(value: unknown): value is PresentationBackend {
  return value === 'libreoffice' || value === 'powerpoint-static'
}
export function playlistPptxBackend(entry: PlaylistEntry): PresentationBackend {
  return entry.filePath.toLowerCase().endsWith('.pptx') ? entry.pptxBackend ?? 'libreoffice' : 'libreoffice'
}
export type PreparationPhase = 'queued' | 'preparing' | 'ready' | 'error'

export interface PreparationStatus {
  phase: PreparationPhase
  error?: string
}

export interface PreparationOptions {
  backend?: PresentationBackend
  priority?: PreparationPriority
  forceLocalCache?: boolean
  cacheSourcePath?: string
  cacheProjectPath?: string | null
}

/** Идентичность исходника до/после подготовки. Строки — чтобы bigint пережил JSON. */
export interface SourceIdentity {
  dev: string
  ino: string
  size: string
  mtimeNs: string
  ctimeNs: string
}

export function identityKey(identity: SourceIdentity): string {
  return [identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs].join(':')
}

export function sameIdentity(a: SourceIdentity, b: SourceIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** Готовый целостный кэш: то, что нужно карточке и рендереру. */
export interface PreparedPresentation {
  sha1: string
  sourceSha1?: string
  totalSlides: number
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, import('./pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('./types.js').SlideVideoLink[]>
  slideKiosk?: boolean
  slideNumbering?: import('./slide-numbering').SlideNumbering
  pageNotes: Record<number, string>
  fonts: string[]
  pdfPath: string
  cacheRoot: string
}

/** Метаданные versioned-root: быстрый индекс по пути/stat после рестарта. */
export interface PreparedCacheMetadata {
  version: number
  sha1: string
  sourceSha1?: string
  backend?: PresentationBackend
  generation: number
  sourcePath: string
  identity: SourceIdentity
  totalSlides: number
  fonts: string[]
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, import('./pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('./types.js').SlideVideoLink[]>
  slideKiosk?: boolean
  slideNumbering?: import('./slide-numbering').SlideNumbering
  pageNotes: Record<number, string>
  /** Для pptx в root есть <sha>.media.json версии 7. */
  hasManifest: boolean
  createdAt: number
}

export type PreparationErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'source_changed'
  | 'libreoffice_missing'
  | 'powerpoint_missing'
  | 'powerpoint_failed'
  | 'powerpoint_uncertain'
  | 'invalid_archive'
  | 'invalid_cache'
  | 'worker_crash'
  | 'io'
  | 'superseded'

export interface PreparationErrorInfo {
  code: PreparationErrorCode
  message: string
  phase?: string
}

/** Сообщения main → utilityProcess worker. */
export type PreparationWorkerRequest =
  | {
      type: 'prepare'
      requestId: string
      filePath: string
      stageDir: string
      sofficePath: string | null
      backend: PresentationBackend
      backendVersion: string
      timeoutMs: number
      language: 'ru' | 'en'
    }
  | { type: 'continue'; requestId: string }
  | { type: 'use-cache'; requestId: string; cacheRoot: string; pdfPath: string }
  | { type: 'cancel'; requestId: string; reason?: string }
  | { type: 'shutdown' }

export interface PreparationWorkerResult {
  sha1: string
  sourceSha1?: string
  totalSlides: number
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, import('./pptx-transition.js').PptxSlideTransition>
  slideBuilds?: Record<number, SlideBuildAnimation>
  slideLinks?: Record<number, import('./types.js').SlideVideoLink[]>
  slideKiosk?: boolean
  slideNumbering?: import('./slide-numbering').SlideNumbering
  pageNotes: Record<number, string>
  fonts: string[]
}

export type PreparationWorkerOutcome =
  | { type: 'prepared'; requestId: string; result: PreparationWorkerResult; artifactsDir: string; identity: SourceIdentity; hasManifest: boolean }
  | { type: 'project-cache'; requestId: string; result: PreparationWorkerResult; cacheRoot: string; pdfPath: string; identity: SourceIdentity }
  | { type: 'error'; requestId: string; error: PreparationErrorInfo }
  | { type: 'cancelled'; requestId: string; forced?: boolean }

/** Сообщения utilityProcess worker → main. */
export type PreparationWorkerMessage =
  | { type: 'ready' }
  | { type: 'hashed'; requestId: string; sha1: string; identity: SourceIdentity }
  | { type: 'phase'; requestId: string; phase: string }
  | PreparationWorkerOutcome
