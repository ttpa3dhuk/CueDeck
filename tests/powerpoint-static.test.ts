import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { powerpointCacheSha } from '../src/main/powerpoint-static'
import { PresentationCache } from '../src/main/presentation-preparation-cache'
import { PresentationPreparationQueue, type WorkerSession, type WorkerOutcome, type WorkerPrepareInput } from '../src/main/presentation-preparation-queue'

it('separates PowerPoint static cache from LibreOffice and PowerPoint versions', () => {
  const source = 'a'.repeat(40)
  const v1 = powerpointCacheSha(source, '16.110.3')
  expect(v1).toMatch(/^[a-f0-9]{40}$/)
  expect(v1).not.toBe(source)
  expect(powerpointCacheSha(source, '16.110.4')).not.toBe(v1)
  expect(powerpointCacheSha(source, '16.110.3')).toBe(v1)
})

it('stops the queue after a PowerPoint timeout without killing the worker or starting the next deck', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuedeck-pp-timeout-'))
  const first = join(dir, 'first.pptx'), second = join(dir, 'second.pptx')
  await writeFile(first, 'one'); await writeFile(second, 'two')
  let starts = 0, kills = 0, cancelReason = ''
  const session: WorkerSession = {
    exited: false,
    prepare(_input: WorkerPrepareInput): Promise<WorkerOutcome> { starts++; return new Promise(() => undefined) },
    cancel(reason: string) { cancelReason = reason },
    async forceStop() { kills++ },
    async shutdown() { /* no child in this fake */ },
  }
  const queue = new PresentationPreparationQueue({
    cache: new PresentationCache({ cacheRoot: join(dir, 'cache') }),
    createWorker: () => session,
    sofficePath: async () => null,
    backend: async () => ({ backend: 'powerpoint-static', version: '16.110.3' }),
    language: () => 'ru', jobTimeoutMs: 20, cancelGraceMs: 10, workerIdleMs: 60_000,
  })
  try {
    const a = queue.prepare(first); void a.catch(() => undefined)
    const until = Date.now() + 1000
    while (starts === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(starts).toBe(1)
    const b = queue.prepare(second); void b.catch(() => undefined)
    await expect(a).rejects.toMatchObject({ code: 'timeout' })
    await expect(b).rejects.toMatchObject({ code: 'cancelled' })
    expect(starts).toBe(1)
    expect(kills).toBe(0)
    expect(cancelReason).toBe('timeout')
    await expect(queue.prepare(first)).rejects.toMatchObject({ code: 'cancelled' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
