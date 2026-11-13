import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PresentationCache } from '../src/main/presentation-preparation-cache'
import { PresentationPreparationQueue, type WorkerSession, type WorkerOutcome } from '../src/main/presentation-preparation-queue'

for (const scenario of ['recoverable', 'uncertain-after-cancel'] as const) {
  it(`PowerPoint queue handles ${scenario} without a real Office process`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pp-review-'))
    const first = join(root, 'first.pptx'), second = join(root, 'second.pptx')
    await writeFile(first, 'first'); await writeFile(second, 'second')
    let release!: (outcome: WorkerOutcome) => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let calls = 0, kills = 0, stage = ''
    const session: WorkerSession = {
      exited: false,
      prepare(input) {
        calls++
        if (calls === 1) {
          stage = input.stageDir
          return new Promise<WorkerOutcome>((resolve) => { release = resolve; started() })
        }
        return Promise.resolve({ type: 'error', error: { code: 'powerpoint_failed', message: 'known failure' } })
      },
      cancel() {},
      async forceStop() { kills++ },
      async shutdown() {},
    }
    const queue = new PresentationPreparationQueue({
      cache: new PresentationCache({ cacheRoot: join(root, 'cache') }),
      createWorker: () => session, sofficePath: async () => null,
      backend: async () => ({ backend: 'powerpoint-static', version: 'test' }),
      language: () => 'en', jobTimeoutMs: 10_000, workerIdleMs: 1,
    })
    try {
      const a = queue.prepare(first).catch((error) => error)
      await ready
      const b = queue.prepare(second).catch((error) => error)
      if (scenario === 'uncertain-after-cancel') queue.cancelPath(first)
      release({ type: 'error', error: { code: scenario === 'recoverable' ? 'powerpoint_failed' : 'powerpoint_uncertain', message: 'test result' } })
      expect((await a).code).toBe(scenario === 'recoverable' ? 'powerpoint_failed' : 'powerpoint_uncertain')
      const secondResult = await b
      if (scenario === 'recoverable') {
        expect(secondResult.code).toBe('powerpoint_failed')
        expect(calls).toBe(2)
      } else {
        expect(secondResult.code).toBe('cancelled')
        expect(calls).toBe(1)
        await expect(access(stage)).resolves.toBeUndefined()
        await expect(queue.prepare(first)).rejects.toMatchObject({ code: 'cancelled' })
      }
      expect(kills).toBe(0)
    } finally {
      await queue.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
}
