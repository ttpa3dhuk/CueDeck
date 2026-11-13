import type { SlideBuildAnimation } from '../shared/types.js'
import {
  type PreparationErrorCode,
  type PreparationWorkerMessage,
  type PreparationWorkerRequest,
  type PreparationWorkerResult,
  type SourceIdentity,
} from '../shared/presentation-preparation.js'
import {
  PreparationFailure,
  inspectCachedArtifacts,
  prepareStagedArtifacts,
  sourceIdentity,
  stageSourceCopy,
} from './presentation-preparation-core.js'
import { ConversionError } from './presentation-preparation-convert.js'
import { powerpointCacheSha } from './powerpoint-static.js'
import { PowerpointExportError } from './powerpoint-static.js'

/**
 * utilityProcess-entry фоновой подготовки. Только файлы, OOXML и LibreOffice:
 * никакого Electron app/StateStore/remote/diag/display-mapping. Все пути,
 * soffice и язык приходят сообщением от main.
 *
 * Один job за раз. Отмена кооперативная: abort проверяется между фазами и
 * убивает живой child soffice текущего job. Синхронный inflate/ZIP-разбор
 * прервать нельзя — main остаётся отзывчивым, потому что это отдельный процесс,
 * а по истечении bounded cancel main вправе убить сам worker.
 */

const parent = process.parentPort
if (!parent) throw new Error('presentation-preparation-worker: parentPort unavailable') // i18n-ok: worker/main error

interface Decision {
  type: 'continue' | 'use-cache' | 'cancel'
  cacheRoot?: string
  pdfPath?: string
}

let active: { requestId: string; controller: AbortController; reason: 'cancelled' | 'timeout' | null } | null = null
let decide: ((decision: Decision) => void) | null = null

function send(message: PreparationWorkerMessage): void {
  parent.postMessage(message)
}

function identityOrNull(value: unknown): value is SourceIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as SourceIdentity
  return typeof identity.dev === 'string' && typeof identity.ino === 'string' &&
    typeof identity.size === 'string' && typeof identity.mtimeNs === 'string' && typeof identity.ctimeNs === 'string'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown, reason: 'cancelled' | 'timeout' | null): PreparationErrorCode {
  if (error instanceof PowerpointExportError) return error.missing ? 'powerpoint_missing' : error.uncertain ? 'powerpoint_uncertain' : 'powerpoint_failed'
  if (reason) return reason
  if (error instanceof PreparationFailure) return error.code
  if (error instanceof ConversionError) return error.code
  return 'io'
}

function waitDecision(): Promise<Decision> {
  return new Promise((resolve) => { decide = resolve })
}

async function run(request: Extract<PreparationWorkerRequest, { type: 'prepare' }>): Promise<void> {
  const controller = new AbortController()
  active = { requestId: request.requestId, controller, reason: null }
  const timedOut = setTimeout(() => {
    if (active?.requestId !== request.requestId || active.reason) return
    active.reason = 'timeout'
    controller.abort()
  }, request.timeoutMs)

  const reply = (message: PreparationWorkerMessage): void => {
    if (active?.requestId === request.requestId) send(message)
  }
  try {
    send({ type: 'phase', requestId: request.requestId, phase: 'copying' })
    const staged = await stageSourceCopy(request.filePath, request.stageDir, controller.signal)
    const cacheSha = request.backend === 'powerpoint-static' && request.filePath.toLowerCase().endsWith('.pptx')
      ? powerpointCacheSha(staged.sha1, request.backendVersion)
      : staged.sha1
    reply({ type: 'hashed', requestId: request.requestId, sha1: cacheSha, identity: staged.identityBefore })

    const decision = await Promise.race([
      waitDecision(),
      new Promise<Decision>((resolve) => {
        if (controller.signal.aborted) resolve({ type: 'cancel' })
        else controller.signal.addEventListener('abort', () => resolve({ type: 'cancel' }), { once: true })
      }),
    ])
    if (decision.type === 'cancel' || controller.signal.aborted) {
      throw new PreparationFailure('cancelled', 'Preparation cancelled', 'copy') // i18n-ok: worker/main error
    }
    if (decision.type === 'use-cache' && decision.cacheRoot && decision.pdfPath) {
      send({ type: 'phase', requestId: request.requestId, phase: 'cache' })
      const cached = await inspectCachedArtifacts({
        cacheRoot: decision.cacheRoot,
        pdfPath: decision.pdfPath,
        sha1: cacheSha,
        originalPath: request.filePath,
        identityBefore: staged.identityBefore,
        signal: controller.signal,
      })
      cached.sourceSha1 = staged.sha1
      if (controller.signal.aborted || active?.reason) throw new PreparationFailure(active?.reason === 'timeout' ? 'timeout' : 'cancelled', 'Preparation cancelled', 'cache') // i18n-ok: worker/main error
      reply({
        type: 'project-cache',
        requestId: request.requestId,
        result: resultOf(cached),
        cacheRoot: cached.artifactsDir,
        pdfPath: decision.pdfPath,
        identity: cached.identity,
      })
      return
    }

    send({ type: 'phase', requestId: request.requestId, phase: 'parsing' })
    const prepared = await prepareStagedArtifacts({
      stagedPath: staged.stagedPath,
      originalPath: request.filePath,
      sha1: cacheSha,
      sourceSha1: staged.sha1,
      backend: request.backend,
      stageDir: request.stageDir,
      identityBefore: staged.identityBefore,
      sofficePath: request.sofficePath,
      timeoutMs: request.timeoutMs,
      signal: controller.signal,
      language: request.language,
    })
    if (controller.signal.aborted || active?.reason) throw new PreparationFailure(active?.reason === 'timeout' ? 'timeout' : 'cancelled', 'Preparation cancelled', 'publish') // i18n-ok: worker/main error
    reply({
      type: 'prepared',
      requestId: request.requestId,
      result: resultOf(prepared),
      artifactsDir: prepared.artifactsDir,
      identity: prepared.identity,
      hasManifest: prepared.hasManifest,
    })
  } catch (error) {
    const reason = active?.requestId === request.requestId ? active.reason : null
    if (reason === 'cancelled' && !(error instanceof PowerpointExportError && error.uncertain)) {
      reply({ type: 'cancelled', requestId: request.requestId, forced: false })
    } else {
      const code = errorCode(error, reason)
      reply({
        type: 'error',
        requestId: request.requestId,
        error: {
          code,
          message: errorMessage(error),
          phase: error instanceof PreparationFailure ? error.phase : undefined,
        },
      })
    }
  } finally {
    clearTimeout(timedOut)
    decide = null
    if (active?.requestId === request.requestId) active = null
  }
}

function resultOf(value: {
  sha1: string
  sourceSha1?: string
  totalSlides: number
  slideMedia: PreparationWorkerResult['slideMedia']
  slideTransitions?: Record<number, number>
  slideBuilds?: Record<number, SlideBuildAnimation>
  pageNotes: Record<number, string>
  fonts: string[]
}): PreparationWorkerResult {
  return {
    sha1: value.sha1,
    sourceSha1: value.sourceSha1,
    totalSlides: value.totalSlides,
    slideMedia: value.slideMedia,
    slideTransitions: value.slideTransitions ?? {},
    slideBuilds: value.slideBuilds ?? {},
    pageNotes: value.pageNotes,
    fonts: value.fonts,
  }
}

parent.on('message', (event) => {
  const message = event.data as PreparationWorkerRequest
  try {
    if (message.type === 'prepare') {
      if (active) {
        send({
          type: 'error',
          requestId: message.requestId,
          error: { code: 'io', message: 'Worker busy with another preparation' }, // i18n-ok: worker/main error
        })
        return
      }
      void run(message)
      return
    }
    if (message.type === 'continue' || message.type === 'use-cache' || message.type === 'cancel') {
      if (!active || active.requestId !== message.requestId) return
      if (message.type === 'cancel') active.reason = 'cancelled'
      const pending = decide
      decide = null
      pending?.(message.type === 'cancel'
        ? { type: 'cancel' }
        : message.type === 'use-cache'
          ? { type: 'use-cache', cacheRoot: message.cacheRoot, pdfPath: message.pdfPath }
          : { type: 'continue' })
      if (message.type === 'cancel') active.controller.abort()
      return
    }
    if (message.type === 'shutdown') {
      active?.controller.abort()
      // utilityProcess завершится; main дополнительно ограничивает ожидание.
      setTimeout(() => process.exit(0), 50)
    }
  } catch (error) {
    const requestId = 'requestId' in message ? String(message.requestId) : ''
    send({ type: 'error', requestId, error: { code: 'io', message: errorMessage(error) } })
  }
})

send({ type: 'ready' })
