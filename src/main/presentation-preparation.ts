import { preparationErrorMessage } from '../shared/preparation-errors.js'
import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type PreparationOptions,
  type PreparationStatus,
  type PreparedPresentation,
} from '../shared/presentation-preparation.js'
import { getLang } from '../shared/i18n.js'
import { log } from './diag.js'
import { localPptxCacheDir, pptxReadCacheDir, registerPreparedRoot, useProjectCache } from './project-cache.js'
import { cachedPdfPathFor, findSoffice } from './pptx-converter.js'
import { PresentationCache } from './presentation-preparation-cache.js'
import {
  PresentationPreparationQueue,
  PreparationError,
  type ProjectCacheDecision,
  type WorkerDecision,
  type WorkerHooks,
  type WorkerOutcome,
  type WorkerPrepareInput,
  type WorkerSession,
} from './presentation-preparation-queue.js'

/**
 * Main-API фоновой подготовки презентаций.
 *
 * Тяжёлая работа (чтение/hash/ZIP/XML/шрифты/страницы PDF/LibreOffice)
 * выполняется в отдельном utilityProcess. Здесь — очередь, project-cache,
 * индексация готовых versioned-root и статусы. Никаких записей в файлы
 * активного эфира: worker пишет только в приватный stage, а публикация — один
 * rename целой папки.
 */

const workerPath = join(__dirname, 'presentation-preparation-worker.js')

class ElectronWorkerSession implements WorkerSession {
  private readonly worker: UtilityProcess
  private pending: {
    requestId: string
    hooks: WorkerHooks
    resolve: (outcome: WorkerOutcome) => void
  } | null = null
  private isExited = false

  constructor() {
    if (!existsSync(workerPath)) {
      throw new Error('presentation-preparation-worker.js не собран: добавьте rollup input') // i18n-ok: worker/main error
    }
    this.worker = utilityProcess.fork(workerPath, [], {
      serviceName: 'CueDeck Presentation Preparation',
    })
    this.worker.on('message', (message: any) => { void this.onMessage(message).catch(() => undefined) })
    this.worker.on('exit', (code) => {
      this.isExited = true
      const pending = this.pending
      this.pending = null
      pending?.resolve({
        type: 'error',
        error: { code: 'worker_crash', message: `Worker exited (${code ?? 'unknown'})` }, // i18n-ok: worker/main error
      })
    })
  }

  get exited(): boolean {
    return this.isExited
  }

  private post(message: unknown): void {
    try {
      this.worker.postMessage(message)
    } catch (error) {
      const pending = this.pending
      this.pending = null
      pending?.resolve({
        type: 'error',
        error: { code: 'worker_crash', message: `Worker unavailable: ${String(error)}` }, // i18n-ok: worker/main error
      })
    }
  }

  private async onMessage(message: any): Promise<void> {
    const pending = this.pending
    if (!pending || !message || message.requestId !== pending.requestId) return
    if (message.type === 'hashed') {
      let decision: WorkerDecision
      try {
        decision = await pending.hooks.onHashed(message.sha1, message.identity)
      } catch (error) {
        decision = { type: 'cancel' }
      }
      if (this.pending !== pending) return
      if (decision.type === 'use-cache') {
        this.post({ type: 'use-cache', requestId: pending.requestId, cacheRoot: decision.cacheRoot, pdfPath: decision.pdfPath })
      } else if (decision.type === 'cancel') {
        this.post({ type: 'cancel', requestId: pending.requestId, reason: 'stale' })
      } else {
        this.post({ type: 'continue', requestId: pending.requestId })
      }
      return
    }
    if (message.type === 'phase') return
    this.pending = null
    if (message.type === 'prepared') {
      pending.resolve({
        type: 'prepared',
        result: message.result,
        artifactsDir: message.artifactsDir,
        identity: message.identity,
        hasManifest: message.hasManifest === true,
      })
    } else if (message.type === 'project-cache') {
      pending.resolve({
        type: 'project-cache',
        result: message.result,
        cacheRoot: message.cacheRoot,
        pdfPath: message.pdfPath,
        identity: message.identity,
      })
    } else if (message.type === 'cancelled') {
      pending.resolve({ type: 'cancelled', forced: message.forced === true })
    } else if (message.type === 'error') {
      pending.resolve({ type: 'error', error: message.error })
    }
  }

  prepare(input: WorkerPrepareInput, hooks: WorkerHooks): Promise<WorkerOutcome> {
    if (this.isExited) {
      return Promise.resolve({ type: 'error', error: { code: 'worker_crash', message: 'Worker already exited' } }) // i18n-ok: worker/main error
    }
    if (this.pending) {
      return Promise.resolve({ type: 'error', error: { code: 'io', message: 'Worker busy with another preparation' } }) // i18n-ok: worker/main error
    }
    return new Promise<WorkerOutcome>((resolve) => {
      this.pending = { requestId: input.requestId, hooks, resolve }
      this.post({ type: 'prepare', ...input })
    })
  }

  cancel(reason: string): void {
    if (!this.pending) return
    this.post({ type: 'cancel', requestId: this.pending.requestId, reason })
  }

  async forceStop(): Promise<void> {
    if (this.isExited) return
    try { this.worker.kill() } catch { /* already gone */ }
    await this.waitExit(2_000)
  }

  async shutdown(): Promise<void> {
    if (this.isExited) return
    try { this.worker.postMessage({ type: 'shutdown' }) } catch { /* already gone */ }
    if (!(await this.waitExit(1_000))) {
      try { this.worker.kill() } catch { /* already gone */ }
      await this.waitExit(1_000)
    }
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.isExited) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
      const check = setInterval(() => {
        if (!this.isExited) return
        clearTimeout(timer)
        clearInterval(check)
        resolve(true)
      }, 10)
      check.unref?.()
    })
  }
}

interface Runtime {
  queue: PresentationPreparationQueue
}

let runtime: Runtime | null = null
const statusListeners = new Set<(path: string, status: PreparationStatus) => void>()

function broadcastStatus(path: string, status: PreparationStatus): void {
  for (const listener of statusListeners) {
    try { listener(path, status) } catch (error) { log.warn('preparation: status listener failed', error) }
  }
}

async function defaultProjectPath(): Promise<string | null> {
  try {
    // Только main: worker этот модуль не импортирует. Если ipc уже поднял
    // StateStore, берём текущий путь проекта; иначе считаем, что проекта нет.
    const { store } = await import('./state.js')
    return store.get().projectPath
  } catch {
    return null
  }
}

function projectCacheLookup(sha1: string, job: { cacheSourcePath: string; cacheProjectPath: string | null }): Promise<ProjectCacheDecision | null> {
  if (!job.cacheProjectPath) return Promise.resolve(null)
  return (async () => {
    const adopted = await useProjectCache(sha1, job.cacheSourcePath, job.cacheProjectPath)
    if (!adopted) return null
    const root = pptxReadCacheDir(sha1)
    const pdf = cachedPdfPathFor(sha1)
    return { cacheRoot: root, pdfPath: pdf }
  })()
}

function createRuntime(): Runtime {
  const cache = new PresentationCache({
    cacheRoot: localPptxCacheDir(),
    registerRoot: registerPreparedRoot,
    log: (level, message, error) => log[level](message, error),
  })
  const queue = new PresentationPreparationQueue({
    cache,
    createWorker: () => new ElectronWorkerSession(),
    sofficePath: () => findSoffice(),
    language: () => getLang(),
    resolveProjectCache: (sha1, job) => projectCacheLookup(sha1, job),
    log: (level, message, error) => log[level](message, error),
  })
  queue.onStatus(broadcastStatus)
  return { queue }
}

function getRuntime(): Runtime {
  if (!runtime) runtime = createRuntime()
  return runtime
}

export async function preparePresentation(
  filePath: string,
  options: PreparationOptions = {},
): Promise<PreparedPresentation> {
  const cacheProjectPath = options.cacheProjectPath === undefined
    ? await defaultProjectPath()
    : options.cacheProjectPath
  try {
    return await getRuntime().queue.prepare(filePath, { ...options, cacheProjectPath })
  } catch (error) {
    const code = error instanceof PreparationError ? error.code : 'io'
    log.warn('preparation failed', error)
    throw new PreparationError(code, preparationErrorMessage(code))
  }
}

/** Алиас для постановки в фон; main может вызывать preparePresentation напрямую. */
export function enqueuePresentation(
  filePath: string,
  options: PreparationOptions = {},
): Promise<PreparedPresentation> {
  return preparePresentation(filePath, { ...options, priority: options.priority ?? 'background' })
}

/** Смена проекта/quit: queued отклоняются, активный child отменяется bounded. */
export function cancelPresentationPreparations(): void {
  runtime?.queue.cancelAll()
}

export function cancelPresentationPreparation(filePath: string): void {
  runtime?.queue.cancelPath(filePath)
}

/** Дождаться активного job (например, перед продолжением после смены проекта). */
export function flushPresentationPreparations(): Promise<void> {
  return runtime?.queue.flush() ?? Promise.resolve()
}

/** Погасить worker после завершения текущего job; для will-quit. */
export function stopPresentationPreparations(): Promise<void> {
  return runtime?.queue.stop() ?? Promise.resolve()
}

export function onPreparationStatus(
  listener: (path: string, status: PreparationStatus) => void,
): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

export { PreparationError }
export type { PreparationOptions, PreparationStatus, PreparedPresentation } from '../shared/presentation-preparation.js'
