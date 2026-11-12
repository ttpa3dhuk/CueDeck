import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn }))

import { PPTX_MANIFEST_VERSION, type PreparationWorkerMessage } from '../src/shared/presentation-preparation'
import { sourceIdentity } from '../src/main/presentation-preparation-core'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PDF = Buffer.from('%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n2 0 obj<</Type /Page>>endobj\n')

function zip(files: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value)
    const filename = Buffer.from(name)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(filename.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(filename.length, 28)
    entry.writeUInt32LE(offset, 42)
    local.push(header, filename, data)
    central.push(entry, filename)
    offset += header.length + filename.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function deck(): Buffer {
  return zip({
    '[Content_Types].xml': '<Types></Types>',
    'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree/></p:cSld></p:sld>',
  })
}

class Port extends EventEmitter {
  readonly messages: PreparationWorkerMessage[] = []
  private waiters: Array<(message: PreparationWorkerMessage) => void> = []
  postMessage = vi.fn((message: PreparationWorkerMessage) => {
    this.messages.push(message)
    const waiting = this.waiters.splice(0)
    for (const resolve of waiting) resolve(message)
  })

  command(data: unknown): void {
    this.emit('message', { data, ports: [] })
  }

  async next(type: PreparationWorkerMessage['type'], timeout = 2_000): Promise<PreparationWorkerMessage> {
    const existing = this.messages.find((message) => message.type === type)
    if (existing) return existing
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} message`)), timeout)
      const waiter = (message: PreparationWorkerMessage): void => {
        if (message.type === type) { clearTimeout(timer); resolve(message) }
        else this.waiters.push(waiter)
      }
      this.waiters.push(waiter)
    })
  }
}

let dir: string
let source: string
let stage: string
let port: Port
let savedParent: PropertyDescriptor | undefined

function fakeSoffice(): void {
  fake.spawn.mockImplementation((_path: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 999_999,
      stderr: new EventEmitter(),
      kill: vi.fn(() => child.emit('close', null)),
    })
    const outputDir = args[args.indexOf('--outdir') + 1]
    const input = args[args.length - 1]
    const output = join(outputDir, `${basename(input).replace(/\.[^.]+$/, '')}.pdf`)
    setTimeout(() => {
      void writeFile(output, PDF).then(() => child.emit('close', 0), () => child.emit('close', 1))
    }, 0)
    return child
  })
}

beforeEach(async () => {
  vi.resetModules()
  fake.spawn.mockReset()
  fakeSoffice()
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-worker-'))
  source = join(dir, 'deck.pptx')
  stage = join(dir, 'stage')
  await writeFile(source, deck())
  port = new Port()
  savedParent = Object.getOwnPropertyDescriptor(process, 'parentPort')
  Object.defineProperty(process, 'parentPort', { configurable: true, value: port })
  await import('../src/main/presentation-preparation-worker')
  await port.next('ready')
})

afterEach(async () => {
  if (savedParent) Object.defineProperty(process, 'parentPort', savedParent)
  else Reflect.deleteProperty(process, 'parentPort')
  await rm(dir, { recursive: true, force: true })
})

describe('presentation preparation utility worker', () => {
  it('stages a hash, waits for main, converts and returns a v7 manifest result', async () => {
    port.command({ type: 'prepare', requestId: 'job-1', filePath: source, stageDir: stage, sofficePath: '/fake/soffice', timeoutMs: 5_000, language: 'ru' })
    const hashed = await port.next('hashed')
    expect(hashed).toMatchObject({ type: 'hashed', requestId: 'job-1' })
    expect((hashed as any).sha1).toMatch(/^[a-f0-9]{40}$/)

    port.command({ type: 'continue', requestId: 'job-1' })
    const result = await port.next('prepared')
    expect(result).toMatchObject({
      type: 'prepared',
      requestId: 'job-1',
      result: { totalSlides: 2, fonts: [] },
      hasManifest: true,
    })
    const payload = result as Extract<PreparationWorkerMessage, { type: 'prepared' }>
    expect(await readFile(join(payload.artifactsDir, `${payload.result.sha1}.pdf`))).toEqual(PDF)
    const manifest = JSON.parse(await readFile(join(payload.artifactsDir, `${payload.result.sha1}.media.json`), 'utf8'))
    expect(manifest.version).toBe(PPTX_MANIFEST_VERSION)
    // Оригинал не изменился.
    expect(await readFile(source)).toEqual(deck())
  })

  it('rejects a source changed during LibreOffice conversion', async () => {
    fake.spawn.mockImplementation((_path: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { pid: 999_998, stderr: new EventEmitter(), kill: vi.fn() })
      const outputDir = args[args.indexOf('--outdir') + 1]
      const input = args[args.length - 1]
      setTimeout(() => {
        void writeFile(source, 'changed while soffice works').then(() => {
          void writeFile(join(outputDir, `${basename(input).replace(/\.[^.]+$/, '')}.pdf`), PDF)
            .then(() => child.emit('close', 0))
        })
      }, 0)
      return child
    })
    port.command({ type: 'prepare', requestId: 'job-2', filePath: source, stageDir: stage, sofficePath: '/fake/soffice', timeoutMs: 5_000, language: 'ru' })
    await port.next('hashed')
    port.command({ type: 'continue', requestId: 'job-2' })
    const result = await port.next('error')
    expect(result).toMatchObject({ type: 'error', requestId: 'job-2', error: { code: 'source_changed' } })
  })

  it('cancels after hash and does not emit a late prepared result', async () => {
    port.command({ type: 'prepare', requestId: 'job-3', filePath: source, stageDir: stage, sofficePath: '/fake/soffice', timeoutMs: 5_000, language: 'ru' })
    await port.next('hashed')
    port.command({ type: 'cancel', requestId: 'job-3', reason: 'project change' })
    const result = await port.next('cancelled')
    expect(result).toMatchObject({ type: 'cancelled', requestId: 'job-3' })
    expect(port.messages.some((message) => message.type === 'prepared')).toBe(false)
  })

  it('rejects a second prepare while the worker is busy', async () => {
    port.command({ type: 'prepare', requestId: 'job-4', filePath: source, stageDir: stage, sofficePath: '/fake/soffice', timeoutMs: 5_000, language: 'ru' })
    port.command({ type: 'prepare', requestId: 'job-5', filePath: source, stageDir: stage, sofficePath: '/fake/soffice', timeoutMs: 5_000, language: 'ru' })
    const error = await port.next('error')
    expect(error).toMatchObject({ type: 'error', requestId: 'job-5' })
    port.command({ type: 'cancel', requestId: 'job-4', reason: 'test cleanup' })
    await port.next('cancelled')
  })
})
