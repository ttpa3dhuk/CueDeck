import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const TYPE = Buffer.from('/Type')
const PAGE = Buffer.from('Page')
const whitespace = (byte: number): boolean => (byte >= 9 && byte <= 13) || byte === 32 || byte === 160

/** Bounded byte scanner; accepts tokens split across arbitrary file chunks. */
export class PdfPageCounter {
  private state: 'type' | 'space' | 'page' | 'end' = 'type'
  private pageOffset = 0
  private typeOffset = 0
  private count = 0

  add(chunk: Buffer): void {
    const buf = chunk
    let offset = 0
    while (offset < buf.length) {
      if (this.state === 'type') {
        if (this.typeOffset) {
          if (buf[offset] === TYPE[this.typeOffset]) {
            offset++
            if (++this.typeOffset === TYPE.length) { this.typeOffset = 0; this.state = 'space' }
            continue
          }
          this.typeOffset = 0
        }
        const found = buf.indexOf(TYPE, offset)
        if (found < 0) {
          for (let length = Math.min(TYPE.length - 1, buf.length - offset); length > 0; length--) {
            if (buf.subarray(buf.length - length).equals(TYPE.subarray(0, length))) { this.typeOffset = length; break }
          }
          return
        }
        offset = found + TYPE.length
        this.state = 'space'
      } else if (this.state === 'space') {
        if (whitespace(buf[offset])) { offset++; continue }
        if (buf[offset] === 47) { offset++; this.pageOffset = 0; this.state = 'page' }
        else this.state = 'type'
      } else if (this.state === 'page') {
        if (buf[offset] === PAGE[this.pageOffset]) {
          offset++
          if (++this.pageOffset === PAGE.length) this.state = 'end'
        } else { this.typeOffset = this.pageOffset === 0 ? 1 : 0; this.state = 'type' }
      } else {
        if (buf[offset] !== 115) this.count++ // /Pages is the tree, not a page.
        this.state = 'type'
      }
    }
  }

  total(): number { return this.count + (this.state === 'end' ? 1 : 0) }
}

/**
 * Advisory page count. Compressed object streams can return 0; PDF.js supplies
 * the authoritative total after loading. Never convert an entire PDF to text.
 */
export function countPdfPages(buf: Buffer): number {
  const counter = new PdfPageCounter()
  counter.add(buf)
  return counter.total()
}

/** One streaming pass for the existing content SHA1 and advisory page count. */
export async function inspectPdfFile(filePath: string): Promise<{ sha1: string; totalSlides: number }> {
  const hash = createHash('sha1')
  const counter = new PdfPageCounter()
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    const bytes = chunk as Buffer
    hash.update(bytes)
    counter.add(bytes)
  }
  return { sha1: hash.digest('hex'), totalSlides: counter.total() }
}
