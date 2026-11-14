import { PDFDataRangeTransport } from 'pdfjs-dist'
import type { PdfFileSource } from '../../shared/pdf-source'

/** PDF.js' URL loader enables ranges only for HTTP(S). Use its public custom
 * transport for our restricted cuedeck-media protocol instead of a full read. */
export class LocalPdfRangeTransport extends PDFDataRangeTransport {
  private requests = new Set<AbortController>()
  private stopped = false
  readonly failure: Promise<never>
  private fail!: (error: unknown) => void

  constructor(private source: PdfFileSource) {
    super(source.size, new Uint8Array(), true)
    this.failure = new Promise((_, reject) => { this.fail = reject })
  }

  requestDataRange(begin: number, end: number): void {
    if (this.stopped) return
    const controller = new AbortController()
    this.requests.add(controller)
    void (async () => {
      try {
        const response = await fetch(this.source.url, {
          headers: { Range: `bytes=${begin}-${end - 1}` }, signal: controller.signal,
        })
        const expected = `bytes ${begin}-${end - 1}/${this.source.size}`
        if (response.status !== 206 || response.headers.get('Content-Range') !== expected) {
          throw new Error('PDF range response does not match the requested document')
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength !== end - begin) throw new Error('Incomplete PDF range response')
        if (!this.stopped) this.onDataRange(begin, bytes)
      } catch (error) {
        if (!this.stopped) { this.abort(); this.fail(error) }
      } finally { this.requests.delete(controller) }
    })()
  }

  abort(): void {
    this.stopped = true
    for (const request of this.requests) request.abort()
    this.requests.clear()
  }
}
