import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ fork: vi.fn(), userData: '', children: [] as any[] }))
vi.mock('electron', () => ({
  app: { getPath: () => fake.userData },
  utilityProcess: { fork: fake.fork },
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: string) => path.endsWith('presentation-preparation-worker.js') || actual.existsSync(path),
  }
})
vi.mock('../src/main/diag', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/pptx-converter', () => ({
  findSoffice: async () => '/fake/soffice',
  cachedPdfPathFor: (sha1: string) => join(fake.userData, 'pptx-cache', `${sha1}.pdf`),
}))

import { PPTX_MANIFEST_VERSION } from '../src/shared/presentation-preparation'
import { sourceIdentity } from '../src/main/presentation-preparation-core'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const PDF = '%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n2 0 obj<</Type /Page>>endobj\n'

class FakeUtility extends EventEmitter {
  readonly messages: any[] = []
  holdContinue = false
  private held: any[] = []
  private stageDir = ''
  private filePath = ''
  private cancelled = new Set<string>()
  kill = vi.fn(() => this.emit('exit', 1))

  postMessage(message: any): void {
    this.messages.push(message)
    void this.handle(message).catch(() => undefined)
  }

  releaseContinue(): void {
    this.holdContinue = false
    for (const message of this.held.splice(0)) void this.handle(message)
  }

  private async handle(message: any): Promise<void> {
    if (message.type === 'prepare') {
      this.stageDir = message.stageDir
      this.filePath = message.filePath
      const identity = await sourceIdentity(message.filePath)
      this.emit('message', { type: 'hashed', requestId: message.requestId, sha1: SHA, identity })
    } else if (message.type === 'continue') {
      if (this.cancelled.has(message.requestId)) return
      if (this.holdContinue) { this.held.push(message); return }
      const artifacts = join(this.stageDir, 'artifacts')
      await mkdir(artifacts, { recursive: true })
      await writeFile(join(artifacts, `${SHA}.pdf`), PDF)
      await writeFile(join(artifacts, `${SHA}.media.json`), JSON.stringify({
        version: PPTX_MANIFEST_VERSION, rebuilt: false, slideMedia: [], pageNotes: { 1: 'note' }, fonts: [],
      }))
      const identity = await sourceIdentity(this.filePath)
      this.emit('message', {
        type: 'prepared',
        requestId: message.requestId,
        result: { sha1: SHA, totalSlides: 2, slideMedia: [], pageNotes: { 1: 'note' }, fonts: [] },
        artifactsDir: artifacts,
        identity,
        hasManifest: true,
      })
    } else if (message.type === 'cancel') {
      this.cancelled.add(message.requestId)
      this.emit('message', { type: 'cancelled', requestId: message.requestId })
    } else if (message.type === 'shutdown') {
      this.emit('exit', 0)
    }
  }
}

let dir: string
let source: string
let api: typeof import('../src/main/presentation-preparation')
let statuses: Array<{ path: string; phase: string; error?: string }>

beforeEach(async () => {
  vi.resetModules()
  fake.fork.mockReset()
  fake.children = []
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-main-'))
  fake.userData = join(dir, 'user-data')
  source = join(dir, 'deck.pptx')
  await writeFile(source, 'deck bytes')
  fake.fork.mockImplementation(() => {
    const child = new FakeUtility()
    fake.children.push(child)
    return child
  })
  api = await import('../src/main/presentation-preparation')
  statuses = []
  api.onPreparationStatus((path, status) => statuses.push({ path, ...status }))
})

afterEach(async () => {
  await api.stopPresentationPreparations().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

describe('presentation preparation main API', () => {
  it('wires utilityProcess, publishes a versioned root and reuses it without a new fork', async () => {
    const first = await api.preparePresentation(source, { cacheProjectPath: null })
    expect(first).toMatchObject({ sha1: SHA, totalSlides: 2, pdfPath: expect.stringContaining(`${SHA}.pdf`) })
    expect(await readFile(first.pdfPath, 'utf8')).toBe(PDF)
    expect(fake.children).toHaveLength(1)
    expect(statuses.map((status) => status.phase)).toEqual(expect.arrayContaining(['queued', 'preparing', 'ready']))
    expect(fake.children[0].messages[0]).toMatchObject({ type: 'prepare', sofficePath: '/fake/soffice', timeoutMs: expect.any(Number), language: expect.any(String) })

    const second = await api.preparePresentation(source, { cacheProjectPath: null })
    expect(second).toEqual(first)
    expect(fake.children).toHaveLength(1)
    expect(fake.children[0].messages.filter((message: any) => message.type === 'prepare')).toHaveLength(1)
  })

  it('cancels the active utilityProcess job and settles the caller', async () => {
    const child = new FakeUtility()
    child.holdContinue = true
    fake.fork.mockImplementation(() => {
      fake.children.push(child)
      return child
    })
    const pending = api.preparePresentation(source, { cacheProjectPath: null, priority: 'foreground' })
    await vi.waitFor(() => expect(child.messages.some((message: any) => message.type === 'prepare')).toBe(true))
    api.cancelPresentationPreparations()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    child.releaseContinue()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(statuses.at(-1)?.phase).toBe('error')
  })
})
