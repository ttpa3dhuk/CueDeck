import { afterEach, expect, it, vi } from 'vitest'
vi.mock('pdfjs-dist', () => ({ PDFDataRangeTransport: class {
  onDataRange = vi.fn()
  constructor(public length: number, public initialData: Uint8Array, public progressiveDone: boolean) {}
} }))
import { LocalPdfRangeTransport } from '../src/renderer/shared/pdf-range-transport'
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())

it('fetches and delivers only the requested range', async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Range': 'bytes 10-12/100' } }))
  vi.stubGlobal('fetch', fetcher)
  const transport = new LocalPdfRangeTransport({ url: 'cuedeck-media://document/program?v=abc', size: 100 })
  transport.requestDataRange(10, 13)
  await vi.waitFor(() => expect(transport.onDataRange).toHaveBeenCalledWith(10, new Uint8Array([1, 2, 3])))
  expect(fetcher.mock.calls[0]).toEqual([expect.stringContaining('v=abc'), expect.objectContaining({ headers: { Range: 'bytes=10-12' } })])
})

it('rejects a full/stale/truncated response instead of feeding the wrong PDF', async () => {
  for (const [status, range, body] of [[200, '', [1, 2, 3]], [206, 'bytes 10-12/999', [1, 2, 3]], [206, 'bytes 10-12/100', [1]]] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(body), { status, headers: { 'Content-Range': range } })))
    const transport = new LocalPdfRangeTransport({ url: 'cuedeck-media://document/program?v=abc', size: 100 })
    const failed = expect(transport.failure).rejects.toThrow()
    transport.requestDataRange(10, 13)
    await failed
    expect(transport.onDataRange).not.toHaveBeenCalled()
  }
})

it('aborts outstanding fetches when the PDF is destroyed', async () => {
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
    signal = options.signal as AbortSignal
    return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }))
  const transport = new LocalPdfRangeTransport({ url: 'cuedeck-media://document/program?v=abc', size: 100 })
  transport.requestDataRange(0, 10); transport.abort(); await flush()
  expect(signal.aborted).toBe(true)
  expect(transport.onDataRange).not.toHaveBeenCalled()
})
