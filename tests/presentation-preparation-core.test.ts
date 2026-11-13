import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PreparationFailure,
  prepareStagedArtifacts,
  sourceIdentity,
  stageSourceCopy,
} from '../src/main/presentation-preparation-core'
import { convertSourceToPdf, type ConvertToPdfOptions } from '../src/main/presentation-preparation-convert'
import { PPTX_MANIFEST_VERSION } from '../src/shared/presentation-preparation'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

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

function hiddenDeck(): Buffer {
  return zip({
    '[Content_Types].xml': '<Types></Types>',
    'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide3.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="p" show="0"><p:cSld><p:spTree/></p:cSld></p:sld>',
    'ppt/slides/slide3.xml': '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>',
  })
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n2 0 obj<</Type /Page>>endobj\n')

let dir: string

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<{ source: string; stage: string }> {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-core-'))
  const source = join(dir, 'deck.pptx')
  const stage = join(dir, 'stage')
  await writeFile(source, deck())
  return { source, stage }
}

function fakeConverter(write: (options: ConvertToPdfOptions) => Promise<void> = async () => undefined) {
  return async (options: ConvertToPdfOptions): Promise<string> => {
    await write(options)
    const output = join(options.outputDir, `${basename(options.sourcePath).replace(/\.[^.]+$/, '')}.pdf`)
    await writeFile(output, PDF)
    return output
  }
}

it('rejects a renamed text file before LibreOffice can silently import it as a presentation', async () => {
  const { source, stage } = await fixture()
  await writeFile(source, 'not a PowerPoint archive')
  const staged = await stageSourceCopy(source, stage)
  const convert = vi.fn(fakeConverter())
  await expect(prepareStagedArtifacts({ stagedPath: staged.stagedPath, originalPath: source,
    sha1: staged.sha1, stageDir: stage, identityBefore: staged.identityBefore,
    sofficePath: '/fake/soffice', timeoutMs: 1000, convert,
  })).rejects.toMatchObject({ code: 'invalid_archive' })
  expect(convert).not.toHaveBeenCalled()
})

describe('presentation preparation core', () => {
  it('uses an injected static exporter without launching PowerPoint and publishes only its PDF', async () => {
    const { source, stage } = await fixture()
    const staged = await stageSourceCopy(source, stage)
    const cacheSha = 'b'.repeat(40)
    const exportStatic = vi.fn(async (_copy: string, outputDir: string, sha: string, _signal: AbortSignal | undefined, exchangeDir: string) => {
      expect(exchangeDir).toContain('powerpoint-exchange')
      const path = join(outputDir, `${sha}.pdf`)
      await writeFile(path, Buffer.from('%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n'))
      return path
    })
    const result = await prepareStagedArtifacts({ stagedPath: staged.stagedPath, originalPath: source,
      sha1: cacheSha, sourceSha1: staged.sha1, stageDir: stage, identityBefore: staged.identityBefore,
      sofficePath: null, timeoutMs: 1000, backend: 'powerpoint-static', exportStatic,
    })
    expect(exportStatic).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ sha1: cacheSha, sourceSha1: staged.sha1, totalSlides: 1, slideMedia: [], hasManifest: true })
    const manifest = JSON.parse(await readFile(join(result.artifactsDir, `${cacheSha}.media.json`), 'utf8'))
    expect(manifest.slideMedia).toEqual([])
  })

  it('rejects a PDF that includes a hidden slide instead of mapping notes to a wrong page', async () => {
    const { source, stage } = await fixture()
    await writeFile(source, hiddenDeck())
    const staged = await stageSourceCopy(source, stage)
    const cacheSha = 'c'.repeat(40)
    await expect(prepareStagedArtifacts({ stagedPath: staged.stagedPath, originalPath: source,
      sha1: cacheSha, sourceSha1: staged.sha1, stageDir: stage, identityBefore: staged.identityBefore,
      sofficePath: null, timeoutMs: 1000, backend: 'powerpoint-static',
      exportStatic: async (_copy, outputDir, sha) => {
        const path = join(outputDir, `${sha}.pdf`)
        await writeFile(path, Buffer.from('%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n2 0 obj<</Type /Page>>endobj\n3 0 obj<</Type /Page>>endobj\n'))
        return path
      },
    })).rejects.toMatchObject({ code: 'io', phase: 'validate' })
  })
  it('hashes a private copy and never changes the source', async () => {
    const { source, stage } = await fixture()
    const before = await readFile(source)
    const staged = await stageSourceCopy(source, stage)
    expect(staged.sha1).toMatch(/^[a-f0-9]{40}$/)
    expect(await readFile(staged.stagedPath)).toEqual(before)
    expect(await readFile(source)).toEqual(before)
    expect(staged.identityBefore).toEqual(await sourceIdentity(source))
  })

  it('writes PDF + manifest v7 into stage and counts pages in the worker', async () => {
    const { source, stage } = await fixture()
    const staged = await stageSourceCopy(source, stage)
    const artifacts = await prepareStagedArtifacts({
      stagedPath: staged.stagedPath,
      originalPath: source,
      sha1: staged.sha1,
      stageDir: stage,
      identityBefore: staged.identityBefore,
      sofficePath: '/fake/soffice',
      timeoutMs: 5_000,
      convert: fakeConverter(),
    })
    expect(artifacts.totalSlides).toBe(2)
    expect(artifacts.hasManifest).toBe(true)
    expect(await readFile(join(artifacts.artifactsDir, `${staged.sha1}.pdf`))).toEqual(PDF)
    const manifest = JSON.parse(await readFile(join(artifacts.artifactsDir, `${staged.sha1}.media.json`), 'utf8'))
    expect(manifest.version).toBe(PPTX_MANIFEST_VERSION)
    expect(manifest.rebuilt).toBe(false)
    expect(manifest.slideMedia).toEqual([])
  })

  it('passes a PDF through without LibreOffice and counts pages in the worker', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-core-pdf-'))
    const source = join(dir, 'deck.pdf')
    const stage = join(dir, 'stage')
    await writeFile(source, PDF)
    const staged = await stageSourceCopy(source, stage)
    const convert = vi.fn(async () => { throw new Error('LibreOffice must not run for PDF') })
    const artifacts = await prepareStagedArtifacts({
      stagedPath: staged.stagedPath,
      originalPath: source,
      sha1: staged.sha1,
      stageDir: stage,
      identityBefore: staged.identityBefore,
      sofficePath: null,
      timeoutMs: 5_000,
      convert,
    })
    expect(convert).not.toHaveBeenCalled()
    expect(artifacts.totalSlides).toBe(2)
    expect(artifacts.hasManifest).toBe(false)
    expect(await readFile(join(artifacts.artifactsDir, `${staged.sha1}.pdf`))).toEqual(PDF)
  })

  it('rejects source_changed if the original changes while LibreOffice is running', async () => {
    const { source, stage } = await fixture()
    const staged = await stageSourceCopy(source, stage)
    await expect(prepareStagedArtifacts({
      stagedPath: staged.stagedPath,
      originalPath: source,
      sha1: staged.sha1,
      stageDir: stage,
      identityBefore: staged.identityBefore,
      sofficePath: '/fake/soffice',
      timeoutMs: 5_000,
      convert: fakeConverter(async () => { await writeFile(source, 'changed during conversion') }),
    })).rejects.toMatchObject({ code: 'source_changed' })
  })

  it('honours cancellation before the expensive OOXML parse', async () => {
    const { source, stage } = await fixture()
    const staged = await stageSourceCopy(source, stage)
    const controller = new AbortController()
    controller.abort()
    await expect(prepareStagedArtifacts({
      stagedPath: staged.stagedPath,
      originalPath: source,
      sha1: staged.sha1,
      stageDir: stage,
      identityBefore: staged.identityBefore,
      sofficePath: '/fake/soffice',
      timeoutMs: 5_000,
      signal: controller.signal,
      convert: fakeConverter(),
    })).rejects.toMatchObject({ code: 'cancelled' })
  })
})

class FakeChild extends EventEmitter {
  pid = 999_999
  stderr = new EventEmitter()
  kill = vi.fn(() => { this.emit('close', null) })
}

describe('presentation preparation converter', () => {
  it('kills only the live child handle on cancel and reports bounded cancellation', async () => {
    const child = new FakeChild()
    const spawnImpl = vi.fn(() => child) as any
    const controller = new AbortController()
    const pending = convertSourceToPdf({
      sofficePath: '/fake/soffice',
      sourcePath: '/stage/source.pptx',
      outputDir: '/stage/artifacts',
      profileDir: '/stage/profile',
      signal: controller.signal,
      killGraceMs: 20,
      spawnImpl,
    })
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(child.kill).toHaveBeenCalled()
    // POSIX: отдельная process group, SIGKILL забирает и soffice.bin.
    // Windows: убивается только прямой child; дерево процессов не гарантировано
    // (taskkill/tree-kill не используется и не обещается).
    expect(spawnImpl).toHaveBeenCalledWith('/fake/soffice', expect.arrayContaining(['--headless', '--convert-to']), expect.objectContaining({ detached: process.platform !== 'win32' }))
  })

  it('times out a hung LibreOffice and does not wait forever', async () => {
    const child = new FakeChild()
    child.kill.mockImplementation(() => undefined)
    const pending = convertSourceToPdf({
      sofficePath: '/fake/soffice',
      sourcePath: '/stage/source.pptx',
      outputDir: '/stage/artifacts',
      profileDir: '/stage/profile',
      timeoutMs: 10,
      killGraceMs: 10,
      spawnImpl: (() => child) as any,
    })
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    expect(child.kill).toHaveBeenCalled()
  })
})
