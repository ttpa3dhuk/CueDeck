/**
 * Контракт фоновой подготовки презентаций. Общий модуль main/worker: здесь
 * только типы, коды ошибок и имена файлов кэша — без Electron, fs и i18n,
 * чтобы worker не тянул состояние приложения.
 */
import type { SlideMedia } from './types.js'

/** Версия OOXML-манифеста (pptx-media). Формат уже используется проектами. */
export const PPTX_MANIFEST_VERSION = 10

/** Папка versioned-кэша внутри userData/pptx-cache. */
export const PREPARED_CACHE_FOLDER = 'prepared'
/** Файл метаданных внутри одного versioned-root. */
export const PREPARED_METADATA_FILE = 'prepared.json'
export const PREPARED_METADATA_VERSION = 1
/** Префикс имени versioned-root: v-<generation>. */
export const PREPARED_VERSION_PREFIX = 'v-'

export type PreparationPriority = 'foreground' | 'background'
export type PreparationPhase = 'queued' | 'preparing' | 'ready' | 'error'

export interface PreparationStatus {
  phase: PreparationPhase
  error?: string
}

export interface PreparationOptions {
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
  totalSlides: number
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, number>
  pageNotes: Record<number, string>
  fonts: string[]
  pdfPath: string
  cacheRoot: string
}

/** Метаданные versioned-root: быстрый индекс по пути/stat после рестарта. */
export interface PreparedCacheMetadata {
  version: number
  sha1: string
  generation: number
  sourcePath: string
  identity: SourceIdentity
  totalSlides: number
  fonts: string[]
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, number>
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
      timeoutMs: number
      language: 'ru' | 'en'
    }
  | { type: 'continue'; requestId: string }
  | { type: 'use-cache'; requestId: string; cacheRoot: string; pdfPath: string }
  | { type: 'cancel'; requestId: string; reason?: string }
  | { type: 'shutdown' }

export interface PreparationWorkerResult {
  sha1: string
  totalSlides: number
  slideMedia: SlideMedia[]
  slideTransitions?: Record<number, number>
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
