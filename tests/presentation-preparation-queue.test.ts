import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PREPARED_CACHE_FOLDER,
  PREPARED_METADATA_FILE,
  PREPARED_METADATA_VERSION,
  PREPARED_VERSION_PREFIX,
  PPTX_MANIFEST_VERSION,
  identityKey,
  type PreparedCacheMetadata,
  type SourceIdentity,
} from '../src/shared/presentation-preparation'
import { PresentationCache, versionName } from '../src/main/presentation-preparation-cache'
import {
  PresentationPreparationQueue,
  PreparationError,
  type WorkerDecision,
  type WorkerHooks,
  type WorkerOutcome,
  type WorkerPrepareInput,
  type WorkerSession,
} from '../src/main/presentation-preparation-queue'
import { sourceIdentity as readIdentity } from '../src/main/presentation-preparation-core'

class FakeSession implements WorkerSession {
  exited = false
  readonly inputs: WorkerPrepareInput[] = []
  hooks: WorkerHooks | null = null
  cancelReasons: string[] = []
  forceStops = 0
  autoCancel = false
  private pending: { resolve: (outcome: WorkerOutcome) => void; reject: (error: Error) => void } | null = null

  prepare(input: WorkerPrepareInput, hooks: WorkerHooks): Promise<WorkerOutcome> {
    this.inputs.push(input)
    this.hooks = hooks
    return new Promise<WorkerOutcome>((resolve, reject) => { this.pending = { resolve, reject } })
  }

  cancel(reason: string): void {
    this.cancelReasons.push(reason)
    if (this.autoCancel) this.resolve({ type: 'cancelled' })
  }

  async forceStop(): Promise<void> {
    this.forceStops++
    this.exited = true
    this.resolve({ type: 'error', error: { code: 'worker_crash', message: 'worker killed' } })
  }

  async shutdown(): Promise<void> {
    this.exited = true
    this.resolve({ type: 'cancelled' })
  }

  resolve(outcome: WorkerOutcome): void {
    const pending = this.pending
    this.pending = null
    pending?.resolve(outcome)
  }

  get lastInput(): WorkerPrepareInput {
    return this.inputs[this.inputs.length - 1]
  }
}

const SHA = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST = {
  version: PPTX_MANIFEST_VERSION,
  rebuilt: false,
  slideMedia: [],
  pageNotes: { 1: 'note' },
  fonts: ['Example Sans'],
}

let dir: string
let cacheRoot: string
let cache: PresentationCache
let queue: PresentationPreparationQueue
let workers: FakeSession[]
let statuses: Array<{ path: string; phase: string; error?: string }>
let registered: Array<{ sha1: string; root: string }>
let projectSha: string | null
let projectCacheResult: { cacheRoot: string; pdfPath: string } | null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-queue-'))
  cacheRoot = join(dir, 'pptx-cache')
  workers = []
  statuses = []
  registered = []
  projectSha = null
  projectCacheResult = null
  cache = new PresentationCache({
    cacheRoot,
    registerRoot: (sha1, root) => registered.push({ sha1, root }),
    log: () => undefined,
  })
  queue = new PresentationPreparationQueue({
    cache,
    createWorker: () => {
      const worker = new FakeSession()
      workers.push(worker)
      return worker
    },
    sofficePath: async () => '/fake/soffice',
    language: () => 'ru',
    resolveProjectCache: async (sha1) => {
      projectSha = sha1
      return projectCacheResult
    },
    jobTimeoutMs: 5_000,
    cancelGraceMs: 50,
    workerIdleMs: 60_000,
    log: () => undefined,
  })
  queue.onStatus((path, status) => statuses.push({ path, ...status }))
})

afterEach(async () => {
  await queue.stop().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

async function waitFor(check: () => boolean, timeout = 2_000): Promise<void> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitFor timeout')
}

async function makeSource(name: string, body = `deck ${name}`): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

function prepare(filePath: string, options: Parameters<PresentationPreparationQueue['prepare']>[1] = {}) {
  const promise = queue.prepare(filePath, options)
  // Тест может оборваться раньше, чем job завершится; не оставляем unhandled.
  void promise.catch(() => undefined)
  return promise
}

function allInputs(): WorkerPrepareInput[] {
  return workers.flatMap((worker) => worker.inputs)
}

it('cancels one removed queued source without cancelling the source already preparing', async () => {
  const a = await makeSource('a.pptx'), b = await makeSource('b.pptx')
  const first = prepare(a)
  await waitFor(() => allInputs().length === 1)
  const second = prepare(b)
  await waitFor(() => statuses.some(s => s.path === b && s.phase === 'queued'))
  queue.cancelPath(b)
  await expect(second).rejects.toMatchObject({ code: 'cancelled' })
  expect(workers[0].cancelReasons).toEqual([])
  await finishPrepared(0)
  await expect(first).resolves.toMatchObject({ sha1: SHA })
  expect(allInputs()).toHaveLength(1)
})

function at(index: number): { session: FakeSession; input: WorkerPrepareInput } {
  let current = 0
  for (const session of workers) {
    for (const input of session.inputs) {
      if (current === index) return { session, input }
      current++
    }
  }
  throw new Error(`no preparation input #${index}`)
}

async function hash(index: number, sha1 = SHA): Promise<WorkerDecision> {
  const { session, input } = at(index)
  const identity = await readIdentity(input.filePath)
  return session.hooks!.onHashed(sha1, identity)
}

async function finishPrepared(
  index: number,
  sha1 = SHA,
  options: { mutateSource?: boolean } = {},
): Promise<void> {
  const { session, input } = at(index)
  const identity = await readIdentity(input.filePath)
  const artifacts = join(input.stageDir, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, `${sha1}.pdf`), '%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n')
  await writeFile(join(artifacts, `${sha1}.media.json`), JSON.stringify(MANIFEST))
  if (options.mutateSource) await writeFile(input.filePath, 'changed while preparing')
  session.resolve({
    type: 'prepared',
    result: {
      sha1,
      totalSlides: 7,
      slideMedia: [],
      pageNotes: { 1: 'note' },
      fonts: [],
    },
    artifactsDir: artifacts,
    identity,
    hasManifest: true,
  })
}

function identityFromKey(path: string, identity: SourceIdentity): string {
  return `${path}\0${identityKey(identity)}`
}

describe('presentation preparation queue', () => {
  it('runs one job, dedups path+stat, upgrades queued background and lets foreground jump the queue', async () => {
    const a = await makeSource('a.pptx')
    const b = await makeSource('b.pptx')
    const c = await makeSource('c.pptx')

    const pa = prepare(a, { priority: 'background' })
    await waitFor(() => workers.length === 1)
    const pb = prepare(b, { priority: 'background' })
    const pc = prepare(c, { priority: 'foreground' })
    const duplicate = prepare(a, { priority: 'foreground' })
    expect(workers).toHaveLength(1)
    expect(workers[0].inputs).toHaveLength(1)

    await hash(0)
    await finishPrepared(0)
    await expect(pa).resolves.toMatchObject({ sha1: SHA, cacheRoot: expect.stringContaining(PREPARED_CACHE_FOLDER) })
    await expect(duplicate).resolves.toBe(await pa)

    // Foreground c обгоняет уже стоящий в очереди background b.
    await waitFor(() => allInputs().length === 2)
    expect(at(1).input.filePath).toBe(c)
    await hash(1)
    await finishPrepared(1)
    await pc

    await waitFor(() => allInputs().length === 3)
    expect(at(2).input.filePath).toBe(b)
    await hash(2)
    await finishPrepared(2)
    await pb

    expect(statuses.filter((status) => status.phase === 'queued').length).toBeGreaterThanOrEqual(3)
    expect(statuses.filter((status) => status.phase === 'ready').length).toBeGreaterThanOrEqual(3)
  })

  it('does not let an error block the next job', async () => {
    const a = await makeSource('a.pptx')
    const b = await makeSource('b.pptx')
    const pa = prepare(a)
    await waitFor(() => workers.length === 1)
    await hash(0)
    at(0).session.resolve({ type: 'error', error: { code: 'invalid_archive', message: 'broken zip' } })
    await expect(pa).rejects.toMatchObject({ code: 'invalid_archive' })

    const pb = prepare(b)
    await waitFor(() => allInputs().length === 2)
    expect(at(1).input.filePath).toBe(b)
    await hash(1, 'a'.repeat(40))
    await finishPrepared(1, 'a'.repeat(40))
    await expect(pb).resolves.toMatchObject({ sha1: 'a'.repeat(40) })
  })

  it('times out a stuck job, cancels its live child and starts the next job', async () => {
    queue.jobTimeoutMs = 30
    queue.cancelGraceMs = 30
    const a = await makeSource('a.pptx')
    const b = await makeSource('b.pptx')
    const pa = prepare(a)
    await waitFor(() => allInputs().length === 1)
    await expect(pa).rejects.toMatchObject({ code: 'timeout' })
    expect(at(0).session.cancelReasons).toContain('timeout')
    expect(at(0).session.forceStops).toBeGreaterThan(0)

    const pb = prepare(b)
    await waitFor(() => allInputs().length === 2)
    await hash(1, 'b'.repeat(40))
    await finishPrepared(1, 'b'.repeat(40))
    await expect(pb).resolves.toMatchObject({ sha1: 'b'.repeat(40) })
  })

  it('rejects source_changed and does not publish a mixed generation', async () => {
    const a = await makeSource('a.pptx')
    const pa = prepare(a)
    await waitFor(() => workers.length === 1)
    await hash(0)
    await finishPrepared(0, SHA, { mutateSource: true })
    await expect(pa).rejects.toMatchObject({ code: 'source_changed' })
    expect(await cache.lookupBySha(SHA)).toBeNull()
    expect(existsSync(join(cacheRoot, PREPARED_CACHE_FOLDER, SHA))).toBe(false)
  })

  it('survives a worker crash, ignores a late result and cancels bounded', async () => {
    const a = await makeSource('a.pptx')
    const b = await makeSource('b.pptx')
    const pa = prepare(a)
    await waitFor(() => workers.length === 1)
    await hash(0)
    const crashed = at(0).session
    crashed.exited = true
    crashed.resolve({ type: 'error', error: { code: 'worker_crash', message: 'exit 1' } })
    await expect(pa).rejects.toMatchObject({ code: 'worker_crash' })

    // Поздний результат старого процесса не должен ничего публиковать.
    crashed.resolve({ type: 'cancelled' })

    const pb = prepare(b)
    await waitFor(() => allInputs().length === 2)
    expect(workers.length).toBe(2)
    await hash(1, 'c'.repeat(40))
    await finishPrepared(1, 'c'.repeat(40))
    await expect(pb).resolves.toMatchObject({ sha1: 'c'.repeat(40) })

    const c = await makeSource('c.pptx')
    const pc = prepare(c)
    const queued = prepare(a)
    await waitFor(() => allInputs().length === 3)
    at(2).session.autoCancel = true
    queue.cancelAll()
    await expect(pc).rejects.toMatchObject({ code: 'cancelled' })
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' })
    expect(at(2).session.cancelReasons).toContain('cancelled')
  })

  it('reuses integral cache on a second call and after a simulated restart', async () => {
    const a = await makeSource('a.pptx')
    const pa = prepare(a)
    await waitFor(() => workers.length === 1)
    await hash(0)
    await finishPrepared(0)
    const first = await pa
    expect(first.cacheRoot).toContain(join(PREPARED_CACHE_FOLDER, SHA))
    const workerCount = workers.length

    const second = await prepare(a)
    expect(second).toEqual(first)
    expect(workers).toHaveLength(workerCount)
    expect(registered.at(-1)).toMatchObject({ sha1: SHA, root: first.cacheRoot })

    // Рестарт приложения: новый cache/queue читает index/versioned-root.
    const restartedCache = new PresentationCache({ cacheRoot, registerRoot: () => undefined })
    const restartedWorkers: FakeSession[] = []
    const restarted = new PresentationPreparationQueue({
      cache: restartedCache,
      createWorker: () => {
        const worker = new FakeSession()
        restartedWorkers.push(worker)
        return worker
      },
      sofficePath: async () => '/fake/soffice',
      language: () => 'ru',
      jobTimeoutMs: 5_000,
      cancelGraceMs: 50,
      workerIdleMs: 60_000,
    })
    try {
      await expect(restarted.prepare(a)).resolves.toEqual(first)
      expect(restartedWorkers).toHaveLength(0)
    } finally {
      await restarted.stop()
    }
  })

  it('reuses a published sha1 for another path without a second conversion', async () => {
    const a = await makeSource('a.pptx')
    const pa = prepare(a)
    await waitFor(() => allInputs().length === 1)
    await hash(0)
    await finishPrepared(0)
    const first = await pa

    const b = await makeSource('b.pptx', 'same deck content, different file metadata')
    const pb = prepare(b)
    await waitFor(() => allInputs().length === 2)
    const decision = await hash(1)
    expect(decision).toEqual({ type: 'use-cache', cacheRoot: first.cacheRoot, pdfPath: first.pdfPath })
    const identity = await readIdentity(b)
    at(1).session.resolve({
      type: 'project-cache',
      result: { sha1: SHA, totalSlides: first.totalSlides, slideMedia: [], pageNotes: { 1: 'note' }, fonts: [] },
      cacheRoot: first.cacheRoot,
      pdfPath: first.pdfPath,
      identity,
    })
    await expect(pb).resolves.toMatchObject({ sha1: SHA, cacheRoot: first.cacheRoot })

    // Второй путь запомнен в index: третье открытие уже без worker.
    await expect(prepare(b)).resolves.toMatchObject({ sha1: SHA, cacheRoot: first.cacheRoot })
    expect(allInputs()).toHaveLength(2)
  })

  it('publishes a whole versioned root atomically and never overwrites the old live version', async () => {
    const a = await makeSource('a.pptx')
    const oldIdentity = await readIdentity(a)
    const oldRoot = join(cacheRoot, PREPARED_CACHE_FOLDER, SHA, versionName(1))
    await mkdir(oldRoot, { recursive: true })
    await writeFile(join(oldRoot, `${SHA}.pdf`), '%PDF old')
    await writeFile(join(oldRoot, `${SHA}.media.json`), JSON.stringify(MANIFEST))
    const oldMetadata: PreparedCacheMetadata = {
      version: PREPARED_METADATA_VERSION,
      sha1: SHA,
      generation: 1,
      sourcePath: a,
      identity: oldIdentity,
      totalSlides: 1,
      fonts: [],
      slideMedia: [],
      pageNotes: {},
      hasManifest: true,
      createdAt: 1,
    }
    await writeFile(join(oldRoot, PREPARED_METADATA_FILE), JSON.stringify(oldMetadata))
    expect(await cache.lookupByIdentity(a, oldIdentity)).not.toBeNull()

    const pa = prepare(a, { forceLocalCache: true })
    await waitFor(() => workers.length === 1)
    await hash(0)
    await finishPrepared(0)
    const published = await pa
    expect(published.cacheRoot).not.toBe(oldRoot)
    expect(published.cacheRoot).toContain(join(PREPARED_CACHE_FOLDER, SHA))
    expect(await readFile(join(oldRoot, `${SHA}.pdf`), 'utf8')).toBe('%PDF old')
    expect(existsSync(join(published.cacheRoot, `${SHA}.pdf`))).toBe(true)
    expect(existsSync(join(published.cacheRoot, PREPARED_METADATA_FILE))).toBe(true)
    // Опубликованный root — уже одна папка, а не набор файлов из stage.
    expect(existsSync(join(published.cacheRoot, `${SHA}.media.json`))).toBe(true)
  })

  it('does not publish a stale active result when forceLocalCache starts a new generation', async () => {
    const a = await makeSource('a.pptx')
    const first = prepare(a, { priority: 'background' })
    await waitFor(() => allInputs().length === 1)
    await hash(0)
    at(0).session.autoCancel = true
    const forced = prepare(a, { forceLocalCache: true, priority: 'foreground' })
    await expect(first).rejects.toMatchObject({ code: expect.stringMatching(/superseded|cancelled/) })
    await waitFor(() => allInputs().length === 2)
    await hash(1, 'f'.repeat(40))
    await finishPrepared(1, 'f'.repeat(40))
    const result = await forced
    expect(result.sha1).toBe('f'.repeat(40))
    expect(result.cacheRoot).not.toContain(SHA)
    expect(await cache.lookupBySha(SHA)).toBeNull()
  })

  it('uses a validated project-cache result without publishing a local version', async () => {
    const a = await makeSource('a.pptx')
    const projectRoot = join(dir, 'project', 'pptx-cache')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, `${SHA}.pdf`), '%PDF project')
    await writeFile(join(projectRoot, `${SHA}.media.json`), JSON.stringify(MANIFEST))
    projectCacheResult = { cacheRoot: projectRoot, pdfPath: join(projectRoot, `${SHA}.pdf`) }
    const pa = prepare(a)
    await waitFor(() => allInputs().length === 1)
    const decision = await hash(0)
    expect(decision).toEqual({ type: 'use-cache', cacheRoot: projectRoot, pdfPath: join(projectRoot, `${SHA}.pdf`) })
    expect(projectSha).toBe(SHA)
    const identity = await readIdentity(a)
    at(0).session.resolve({
      type: 'project-cache',
      result: { sha1: SHA, totalSlides: 4, slideMedia: [], pageNotes: {}, fonts: [] },
      cacheRoot: projectRoot,
      pdfPath: join(projectRoot, `${SHA}.pdf`),
      identity,
    })
    await expect(pa).resolves.toMatchObject({ sha1: SHA, cacheRoot: projectRoot })
    expect(existsSync(join(cacheRoot, PREPARED_CACHE_FOLDER, SHA))).toBe(false)
  })
})
