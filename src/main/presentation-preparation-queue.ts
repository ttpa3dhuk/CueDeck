import { resolve } from 'node:path'
import {
  identityKey,
  sameIdentity,
  type PreparationErrorCode,
  type PreparationErrorInfo,
  type PreparationOptions,
  type PreparationPriority,
  type PreparationStatus,
  type PreparationWorkerResult,
  type PreparedPresentation,
  type SourceIdentity,
} from '../shared/presentation-preparation.js'
import { PresentationCache } from './presentation-preparation-cache.js'
import { sourceIdentity } from './presentation-preparation-core.js'

/**
 * Очередь подготовки: один активный job, dedup path+stat, foreground впереди
 * queued background, bounded cancel, публикация только после проверки identity.
 * Не зависит от Electron — worker и project-cache подставляются снаружи.
 */

export class PreparationError extends Error {
  constructor(
    readonly code: PreparationErrorCode,
    message: string,
    readonly phase?: string,
  ) {
    super(message)
    this.name = 'PreparationError'
  }
}

export interface WorkerPrepareInput {
  requestId: string
  filePath: string
  stageDir: string
  sofficePath: string | null
  timeoutMs: number
  language: 'ru' | 'en'
}

export type WorkerDecision =
  | { type: 'continue' }
  | { type: 'use-cache'; cacheRoot: string; pdfPath: string }
  | { type: 'cancel' }

export interface WorkerHooks {
  onHashed(sha1: string, identity: SourceIdentity): Promise<WorkerDecision>
}

export type WorkerOutcome =
  | {
      type: 'prepared'
      result: PreparationWorkerResult
      artifactsDir: string
      identity: SourceIdentity
      hasManifest: boolean
    }
  | {
      type: 'project-cache'
      result: PreparationWorkerResult
      cacheRoot: string
      pdfPath: string
      identity: SourceIdentity
    }
  | { type: 'error'; error: PreparationErrorInfo }
  | { type: 'cancelled'; forced?: boolean }

export interface WorkerSession {
  /** true, если процесс уже завершился (crash/shutdown). */
  readonly exited: boolean
  prepare(input: WorkerPrepareInput, hooks: WorkerHooks): Promise<WorkerOutcome>
  /** Кооперативная отмена текущего job. */
  cancel(reason: string): void
  /** Ограниченное ожидание, затем kill живого handle. */
  forceStop(): Promise<void>
  shutdown(): Promise<void>
}

export interface ProjectCacheDecision {
  cacheRoot: string
  pdfPath: string
}

export interface PreparationQueueOptions {
  cache: PresentationCache
  createWorker: () => WorkerSession
  /** Путь к soffice и язык — из main, не из worker-окружения. */
  sofficePath: () => Promise<string | null>
  language: () => 'ru' | 'en'
  /** Проверить project-cache по уже посчитанному SHA1; null — готовить stage. */
  resolveProjectCache?: (sha1: string, job: PreparedJobView) => Promise<ProjectCacheDecision | null>
  jobTimeoutMs?: number
  cancelGraceMs?: number
  workerIdleMs?: number
  log?: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void
}

export interface PreparedJobView {
  filePath: string
  cacheSourcePath: string
  cacheProjectPath: string | null
  priority: PreparationPriority
  forceLocalCache: boolean
}

interface Job extends PreparedJobView {
  id: string
  identity: SourceIdentity
  generation: number
  stageDir: string | null
  session: WorkerSession | null
  promise: Promise<PreparedPresentation>
  resolve: (value: PreparedPresentation) => void
  reject: (error: PreparationError) => void
  settled: boolean
  stale: boolean
  cancelReason: 'cancelled' | 'timeout' | 'superseded' | null
  timeout: ReturnType<typeof setTimeout> | null
  watchdog: ReturnType<typeof setTimeout> | null
  status: PreparationStatus
}

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_CANCEL_GRACE_MS = 3_000
const DEFAULT_WORKER_IDLE_MS = 30_000

export class PresentationPreparationQueue {
  private readonly cache: PresentationCache
  private readonly createWorker: () => WorkerSession
  private readonly resolveProjectCache?: (sha1: string, job: PreparedJobView) => Promise<ProjectCacheDecision | null>
  private readonly sofficePath: () => Promise<string | null>
  private readonly language: () => 'ru' | 'en'
  private readonly log: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void
  private readonly listeners = new Set<(path: string, status: PreparationStatus) => void>()
  private readonly queue: Job[] = []
  private readonly jobsByKey = new Map<string, Job>()
  private readonly jobsByPath = new Map<string, Set<Job>>()
  private session: WorkerSession | null = null
  private active: Job | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private generation = Date.now() * 1_000
  private stopped = false
  jobTimeoutMs: number
  cancelGraceMs: number
  workerIdleMs: number

  constructor(options: PreparationQueueOptions) {
    this.cache = options.cache
    this.createWorker = options.createWorker
    this.sofficePath = options.sofficePath
    this.language = options.language
    this.resolveProjectCache = options.resolveProjectCache
    this.log = options.log ?? (() => undefined)
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
    this.workerIdleMs = options.workerIdleMs ?? DEFAULT_WORKER_IDLE_MS
  }

  onStatus(listener: (path: string, status: PreparationStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private status(job: Job, phase: PreparationStatus['phase'], error?: string): void {
    job.status = { phase, ...(error ? { error } : {}) }
    for (const listener of this.listeners) {
      try { listener(job.filePath, job.status) } catch (err) { this.log('warn', 'preparation: status listener failed', err) }
    }
  }

  private nextGeneration(): number {
    this.generation += 1
    return this.generation
  }

  private settle(job: Job, error?: PreparationError, value?: PreparedPresentation): void {
    if (job.settled) return
    job.settled = true
    if (job.timeout) clearTimeout(job.timeout)
    if (job.watchdog) clearTimeout(job.watchdog)
    job.timeout = null
    job.watchdog = null
    const key = `${job.filePath}\0${identityKey(job.identity)}`
    if (this.jobsByKey.get(key) === job) this.jobsByKey.delete(key)
    const set = this.jobsByPath.get(job.filePath)
    set?.delete(job)
    if (set && set.size === 0) this.jobsByPath.delete(job.filePath)
    if (error) {
      this.status(job, 'error', error.message)
      job.reject(error)
    } else {
      this.status(job, 'ready')
      job.resolve(value!)
    }
  }

  private track(job: Job): void {
    this.jobsByKey.set(`${job.filePath}\0${identityKey(job.identity)}`, job)
    let set = this.jobsByPath.get(job.filePath)
    if (!set) { set = new Set(); this.jobsByPath.set(job.filePath, set) }
    set.add(job)
  }

  private dropQueued(job: Job, error: PreparationError): void {
    const at = this.queue.indexOf(job)
    if (at >= 0) this.queue.splice(at, 1)
    this.settle(job, error)
  }

  private supersedePath(filePath: string, keep: Job): void {
    const jobs = this.jobsByPath.get(filePath)
    if (!jobs) return
    for (const job of [...jobs]) {
      if (job === keep || job.settled) continue
      job.stale = true
      if (this.active === job) {
        job.cancelReason = 'superseded'
        this.cancelActive(job, 'superseded')
      } else {
        this.dropQueued(job, new PreparationError('superseded', 'Superseded by newer preparation')) // i18n-ok: worker/main error
      }
    }
  }

  private enqueue(job: Job, priority: PreparationPriority): void {
    if (priority === 'foreground') {
      const at = this.queue.findIndex((queued) => queued.priority === 'background')
      if (at < 0) this.queue.push(job)
      else this.queue.splice(at, 0, job)
    } else {
      this.queue.push(job)
    }
  }

  async prepare(filePath: string, options: PreparationOptions = {}): Promise<PreparedPresentation> {
    if (this.stopped) throw new PreparationError('cancelled', 'Preparation stopped') // i18n-ok: worker/main error
    const canonical = resolve(filePath)
    const priority = options.priority ?? 'background'
    const forceLocalCache = options.forceLocalCache === true
    const cacheSourcePath = resolve(options.cacheSourcePath ?? canonical)
    const cacheProjectPath = options.cacheProjectPath === undefined ? null : options.cacheProjectPath
    let identity: SourceIdentity
    try {
      identity = await sourceIdentity(canonical)
    } catch (error) {
      throw new PreparationError('io', `File unavailable: ${String(error)}`) // i18n-ok: worker/main error
    }
    const key = `${canonical}\0${identityKey(identity)}`
    if (!forceLocalCache) {
      const current = this.jobsByKey.get(key)
      if (current && !current.settled) {
        if (priority === 'foreground' && current.priority === 'background' && current !== this.active) {
          current.priority = 'foreground'
          const at = this.queue.indexOf(current)
          if (at >= 0) this.queue.splice(at, 1)
          this.enqueue(current, 'foreground')
        }
        return current.promise
      }
      const cached = await this.cache.lookupByIdentity(canonical, identity)
      if (cached) {
        for (const listener of this.listeners) {
          try { listener(canonical, { phase: 'ready' }) } catch { /* status listener */ }
        }
        return cached
      }
      const raced = this.jobsByKey.get(key)
      if (raced && !raced.settled) return raced.promise
    }

    let resolveJob!: (value: PreparedPresentation) => void
    let rejectJob!: (error: PreparationError) => void
    const promise = new Promise<PreparedPresentation>((resolveValue, rejectValue) => {
      resolveJob = resolveValue
      rejectJob = rejectValue
    })
    const job: Job = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      filePath: canonical,
      identity,
      priority,
      forceLocalCache,
      cacheSourcePath,
      cacheProjectPath,
      generation: this.nextGeneration(),
      stageDir: null,
      session: null,
      promise,
      resolve: resolveJob,
      reject: rejectJob,
      settled: false,
      stale: false,
      cancelReason: null,
      timeout: null,
      watchdog: null,
      status: { phase: 'queued' },
    }
    // Caller gets the promise before it is returned; avoid unhandled rejection
    // when the caller is not awaiting a superseded duplicate.
    void promise.catch(() => undefined)
    this.track(job)
    // Другой stat того же пути — это уже другой файл: старый job не должен
    // опубликовать смесь старого и нового.
    this.supersedePath(canonical, job)
    this.enqueue(job, priority)
    this.status(job, 'queued')
    void this.pump()
    return promise
  }

  private ensureWorker(): WorkerSession {
    if (this.session && !this.session.exited) return this.session
    this.session = null
    const worker = this.createWorker()
    this.session = worker
    return worker
  }

  private cancelActive(job: Job, reason: 'cancelled' | 'timeout' | 'superseded'): void {
    if (this.active !== job) return
    if (job.cancelReason === 'timeout') return
    job.cancelReason = reason
    job.stale = true
    const session = job.session
    try { session?.cancel(reason) } catch (error) { this.log('warn', 'preparation: cancel failed', error) }
    const timer = setTimeout(() => {
      if (this.active !== job) return
      this.log('warn', `preparation: worker did not confirm cancellation (${reason}) after ${this.cancelGraceMs} ms`) // i18n-ok: worker/main error
      void session?.forceStop().catch((error) => this.log('warn', 'preparation: forceStop failed', error))
    }, this.cancelGraceMs)
    timer.unref?.()
  }

  private watchdogFor(job: Job): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.active !== job || job.settled) return
      this.log('warn', `preparation: job exceeded timeout ${this.jobTimeoutMs} ms`) // i18n-ok: worker/main error
      job.cancelReason = 'timeout'
      job.stale = true
      try { job.session?.cancel('timeout') } catch { /* live handle only */ }
      const kill = setTimeout(() => {
        if (this.active !== job) return
        void job.session?.forceStop().catch(() => undefined)
      }, this.cancelGraceMs)
      kill.unref?.()
    }, this.jobTimeoutMs + this.cancelGraceMs)
    timer.unref?.()
    return timer
  }

  private async pump(): Promise<void> {
    if (this.active || this.queue.length === 0 || this.stopped) return
    const job = this.queue.shift()!
    if (job.settled) { void this.pump(); return }
    this.active = job
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.status(job, 'preparing')
    try {
      try {
        job.stageDir = await this.cache.stageDir(job.id)
      } catch (error) {
        throw new PreparationError('io', `Не удалось создать stage: ${error instanceof Error ? error.message : String(error)}`) // i18n-ok: worker/main error
      }
      if (job.settled || job.stale) {
        await this.cache.discardStage(job.stageDir)
        job.stageDir = null
        if (!job.settled) this.settle(job, new PreparationError('superseded', 'Superseded by newer preparation')) // i18n-ok: worker/main error
        return
      }
      const session = this.ensureWorker()
      job.session = session
      job.watchdog = this.watchdogFor(job)
      const [sofficePath, language] = await Promise.all([this.sofficePath(), Promise.resolve(this.language())])
      const outcome = await session.prepare({
        requestId: job.id,
        filePath: job.filePath,
        stageDir: job.stageDir,
        sofficePath,
        timeoutMs: this.jobTimeoutMs,
        language,
      }, {
        onHashed: async (sha1) => {
          if (job.stale || job.settled) return { type: 'cancel' }
          if (!job.forceLocalCache) {
            // Тот же sha1 мог уже быть подготовлен под другим путём/stat:
            // не конвертируем заново, а читаем целостный versioned-root.
            try {
              const cached = await this.cache.lookupBySha(sha1)
              if (cached) return { type: 'use-cache', cacheRoot: cached.cacheRoot, pdfPath: cached.pdfPath }
            } catch (error) {
              this.log('warn', 'preparation: local cache lookup failed', error)
            }
            if (this.resolveProjectCache) {
              try {
                const cached = await this.resolveProjectCache(sha1, job)
                if (cached) return { type: 'use-cache', ...cached }
              } catch (error) {
                this.log('warn', 'preparation: project-cache lookup failed', error)
              }
            }
          }
          return { type: 'continue' }
        },
      })
      await this.finish(job, outcome)
    } catch (error) {
      const failure = error instanceof PreparationError
        ? error
        : new PreparationError('worker_crash', error instanceof Error ? error.message : String(error))
      if (job.cancelReason === 'timeout') this.settle(job, new PreparationError('timeout', 'Preparation exceeded timeout')) // i18n-ok: worker/main error
      else if (job.cancelReason) this.settle(job, new PreparationError(job.cancelReason === 'superseded' ? 'superseded' : 'cancelled', 'Preparation cancelled')) // i18n-ok: worker/main error
      else this.settle(job, failure)
    } finally {
      if (job.stageDir) await this.cache.discardStage(job.stageDir)
      job.stageDir = null
      job.session = null
      if (this.active === job) this.active = null
      if (job.settled && !job.promise) { /* no-op */ }
      void this.pump()
      this.scheduleIdleShutdown()
    }
  }

  private async finish(job: Job, outcome: WorkerOutcome): Promise<void> {
    if (job.stale) {
      const code = job.cancelReason === 'timeout' ? 'timeout' : job.cancelReason === 'superseded' ? 'superseded' : 'cancelled'
      throw new PreparationError(code, code === 'timeout' ? 'Preparation exceeded timeout' : 'Preparation cancelled') // i18n-ok: worker/main error
    }
    if (outcome.type === 'cancelled') {
      throw new PreparationError(job.cancelReason === 'timeout' ? 'timeout' : job.cancelReason === 'superseded' ? 'superseded' : 'cancelled', 'Preparation cancelled') // i18n-ok: worker/main error
    }
    if (outcome.type === 'error') {
      const code = job.cancelReason === 'timeout' ? 'timeout' : outcome.error.code
      const message = job.cancelReason === 'timeout' ? 'Preparation exceeded timeout' : outcome.error.message // i18n-ok: worker/main error
      throw new PreparationError(code, message, outcome.error.phase)
    }
    let current: SourceIdentity
    try {
      current = await sourceIdentity(job.filePath)
    } catch {
      throw new PreparationError('source_changed', 'Source changed during preparation') // i18n-ok: worker/main error
    }
    if (!sameIdentity(current, job.identity) || !sameIdentity(outcome.identity, job.identity)) {
      throw new PreparationError('source_changed', 'Source changed during preparation') // i18n-ok: worker/main error
    }
    if (job.stale) throw new PreparationError('cancelled', 'Preparation cancelled') // i18n-ok: worker/main error
    if (outcome.type === 'project-cache') {
      const result: PreparedPresentation = {
        sha1: outcome.result.sha1,
        totalSlides: outcome.result.totalSlides,
        slideMedia: outcome.result.slideMedia,
        slideTransitions: outcome.result.slideTransitions ?? {},
        pageNotes: outcome.result.pageNotes,
        fonts: outcome.result.fonts,
        pdfPath: outcome.pdfPath,
        cacheRoot: outcome.cacheRoot,
      }
      await this.cache.rememberPath(job.filePath, job.identity, result).catch((error) => {
        this.log('warn', 'preparation: не удалось запомнить путь в index', error) // i18n-ok: worker/main error
      })
      this.settle(job, undefined, result)
      return
    }
    const reused = job.forceLocalCache ? null : await this.cache.lookupBySha(outcome.result.sha1)
    if (job.stale) throw new PreparationError('cancelled', 'Preparation cancelled') // i18n-ok: worker/main error
    if (reused) {
      await this.cache.rememberPath(job.filePath, job.identity, reused).catch((error) => {
        this.log('warn', 'preparation: не удалось запомнить путь в index', error) // i18n-ok: worker/main error
      })
      this.settle(job, undefined, reused)
      return
    }
    let published: PreparedPresentation
    try {
      published = await this.cache.publish({
      artifactsDir: outcome.artifactsDir,
      sha1: outcome.result.sha1,
      generation: job.generation,
      sourcePath: job.filePath,
      identity: job.identity,
      totalSlides: outcome.result.totalSlides,
      slideMedia: outcome.result.slideMedia,
      slideTransitions: outcome.result.slideTransitions ?? {},
      pageNotes: outcome.result.pageNotes,
      fonts: outcome.result.fonts,
        hasManifest: outcome.hasManifest,
        commitGuard: () => !job.stale && !job.settled,
      })
    } catch (error) {
      if (job.stale) {
        throw new PreparationError(job.cancelReason === 'superseded' ? 'superseded' : 'cancelled', 'Preparation cancelled') // i18n-ok: worker/main error
      }
      throw new PreparationError('io', `Не удалось опубликовать кэш: ${error instanceof Error ? error.message : String(error)}`) // i18n-ok: worker/main error
    }
    this.settle(job, undefined, published)
  }

  private scheduleIdleShutdown(): void {
    if (this.stopped || this.active || this.queue.length || !this.session || this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.active || this.queue.length || this.stopped) return
      const session = this.session
      this.session = null
      void session?.shutdown().catch((error) => this.log('warn', 'preparation: shutdown failed', error))
    }, this.workerIdleMs)
    this.idleTimer.unref?.()
  }

  /** Сменить проект/quit: queued reject, active cancel bounded. */
  cancelPath(filePath: string): void {
    const jobs = this.jobsByPath.get(resolve(filePath))
    if (!jobs) return
    for (const job of [...jobs]) {
      if (job.settled) continue
      if (job === this.active) this.cancelActive(job, 'cancelled')
      else this.dropQueued(job, new PreparationError('cancelled', 'Preparation cancelled'))
    }
  }

  cancelAll(): void {
    const error = new PreparationError('cancelled', 'Preparation cancelled') // i18n-ok: worker/main error
    for (const job of [...this.queue]) this.dropQueued(job, error)
    if (this.active) this.cancelActive(this.active, 'cancelled')
  }

  /** Дождаться текущего активного job (без остановки очереди). */
  async flush(): Promise<void> {
    const active = this.active
    if (active) await active.promise.catch(() => undefined)
  }

  /** Дождаться завершения активного job и погасить worker. */
  async stop(): Promise<void> {
    this.stopped = true
    this.cancelAll()
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    const active = this.active
    if (active) {
      const bounded = new Promise<void>((resolveStop) => {
        const timer = setTimeout(resolveStop, this.cancelGraceMs + 1_000)
        timer.unref?.()
      })
      await Promise.race([active.promise.catch(() => undefined), bounded])
      if (this.active === active) {
        if (!active.settled) {
          await active.session?.forceStop().catch(() => undefined)
          await new Promise<void>((resolveStop) => {
            const timer = setTimeout(resolveStop, 500)
            timer.unref?.()
          })
        }
        if (this.active === active) {
          this.settle(active, new PreparationError('cancelled', 'Preparation cancelled')) // i18n-ok: worker/main error
          this.active = null
        }
      }
    }
    const session = this.session
    this.session = null
    await session?.shutdown().catch((error) => this.log('warn', 'preparation: shutdown failed', error))
    this.stopped = false
  }

}
