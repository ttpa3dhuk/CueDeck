import { join, win32 } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PPTX_MANIFEST_VERSION } from '../src/shared/presentation-preparation'

// No OS writes: even the vulnerable implementation only writes to this map.
const disk = vi.hoisted(() => ({ files: new Map<string, Buffer>(), writes: [] as string[] }))
vi.mock('node:fs/promises', () => ({
  readFile: async (path: string, encoding?: string) => {
    const data = disk.files.get(path)
    if (!data) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
    return encoding ? data.toString('utf8') : data
  },
  writeFile: async (path: string, data: string | Buffer) => {
    disk.writes.push(path)
    disk.files.set(path, Buffer.from(data))
  },
  mkdir: async () => undefined,
  rm: async (path: string) => { disk.files.delete(path) },
}))
vi.mock('node:fs', () => ({ existsSync: (path: string) => disk.files.has(path) }))
vi.mock('../src/main/project-cache', () => ({
  PPTX_MANIFEST_VERSION: 7,
  localPptxCacheDir: () => '/fixture/cache',
  pptxReadCacheDir: () => '/fixture/cache',
  pdfCachePath: (root: string, sha: string) => disk.files.has(`${root}/${sha}.pdf`) ? `${root}/${sha}.pdf` : null,
}))
vi.mock('../src/main/pptx-converter', () => ({
  cachedPdfPathFor: (sha: string) => `/fixture/cache/${sha}.pdf`,
}))

import { preparePptxMedia } from '../src/main/pptx-media'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const SOURCE = '/fixture/deck.pptx'
const MEDIA_DIR = join('/fixture/cache', `${SHA}.media`)
const MANIFEST = join('/fixture/cache', `${SHA}.media.json`)
const VIDEO = Buffer.from([0, 1, 2, 3, 255, 128, 0, 42])
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

// Store-only ZIP assembled in memory: hostile entry names are never filesystem paths.
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

function deck(names: string[]): Buffer {
  const files: Record<string, string | Buffer> = {
    '[Content_Types].xml': '<Types></Types>',
    'ppt/presentation.xml': '<p:presentation><p:sldIdLst>' +
      names.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i}"/>`).join('') +
      '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships>' +
      names.map((_, i) => `<Relationship Id="rId${i}" Type="${REL}/slide" Target="slides/slide${i}.xml"/>`).join('') +
      '</Relationships>',
  }
  names.forEach((name, i) => {
    files[`ppt/slides/slide${i}.xml`] = '<p:sld><p:cSld><p:spTree>' +
      '<p:pic><p:nvPicPr><p:cNvPr id="6" name="video"/><p:cNvPicPr/>' +
      '<p:nvPr><a:videoFile r:link="video"/></p:nvPr></p:nvPicPr></p:pic>' +
      '</p:spTree></p:cSld></p:sld>'
    files[`ppt/slides/_rels/slide${i}.xml.rels`] =
      `<Relationships><Relationship Id="video" Type="${REL}/video" Target="../media/${name}"/></Relationships>`
    files[`ppt/media/${name}`] = VIDEO
  })
  return zip(files)
}

beforeEach(() => {
  disk.files.clear()
  disk.writes.length = 0
})

describe('PPTX media extraction paths', () => {
  it.each([
    String.raw`..\..\victim.mp4`,
    String.raw`sub\..\..\..\victim.mp4`,
    String.raw`C:\victim.mp4`,
    String.raw`\\server\share\victim.mp4`,
    'C:victim.mp4',
    'clip.mp4:payload.mp4',
    'clip\0.mp4',
  ])('rejects unsafe Windows filename %j before any cache write', async (name) => {
    // A good video first ensures validation is complete before extraction starts.
    disk.files.set(SOURCE, deck(['normal.mp4', name]))
    const prepared = await preparePptxMedia(SOURCE, SHA)
    const videoWrites = disk.writes.filter((path) => disk.files.get(path)?.equals(VIDEO))
    // Interpret real write arguments with Windows rules even when CI runs on macOS.
    for (const path of videoWrites) {
      const rel = win32.relative(MEDIA_DIR, win32.normalize(path))
      expect(rel, `media write escaped cache: ${path}`).not.toMatch(/^\.\.(?:\\|$)/)
      expect(win32.isAbsolute(rel)).toBe(false)
    }
    expect(disk.writes).toEqual([])
    expect(prepared).toMatchObject({ slideMedia: [], temporary: false, convertSource: SOURCE })
  })

  it.each(['media1.mp4', 'Доклад 1.MP4', 'clip.v2.final.mov', 'clip..v2.webm', '100% ready.m4v', 'nested/clip.mp4'])
  ('preserves supported media name %j and cached reopening', async (name) => {
    disk.files.set(SOURCE, deck([name]))
    const prepared = await preparePptxMedia(SOURCE, SHA)
    const filename = name.split('/').pop()!
    expect(prepared.slideMedia).toEqual([
      { slide: 1, file: filename, rect: { x: 0, y: 0, w: 1, h: 1 }, autoPlay: false, loop: false },
    ])
    expect(disk.files.get(join(MEDIA_DIR, filename))).toEqual(VIDEO)
    expect(prepared.temporary).toBe(true)
    const manifestBytes = disk.files.get(MANIFEST)
    expect(JSON.parse(manifestBytes!.toString()).version).toBe(PPTX_MANIFEST_VERSION)
    disk.files.set(`/fixture/cache/${SHA}.pdf`, Buffer.from('ready PDF'))
    disk.writes.length = 0
    const cached = await preparePptxMedia(SOURCE, SHA)
    expect(cached.slideMedia).toEqual(prepared.slideMedia)
    expect(cached.temporary).toBe(false)
    expect(disk.writes).toEqual([])
    expect(disk.files.get(MANIFEST)).toEqual(manifestBytes)
  })
})
