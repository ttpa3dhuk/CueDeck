/** Node-only raster/scheduler experiment; never starts Electron or reads userData.
 * Node >=22.12; run with vite-node. PDF paths/results stay outside public Git.
 * --mode shared|independent --pdf /path/file.pdf --output /path/result.json
 * --pages 1,2,3,... --width 960 --consumers 4
 */
import { open, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { PdfFrameBackend } from '../src/render-backends/pdfjs'
import { SlideFrameSource } from '../packages/render-core/src/frame-source'

const require = createRequire(import.meta.url)
const { createCanvas } = require('@napi-rs/canvas')
// Node PDF.js installs DOMMatrix/Path2D using its optional native canvas package.
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const arg = (name: string, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const path = arg('pdf')
const secondary = arg('secondary')
const output = arg('output')
const mode = arg('mode', 'shared')
const width = Number(arg('width', '960'))
const height = Math.round(width * 9 / 16)
const consumerCount = Number(arg('consumers', '4'))
if (!path || !output || !['shared', 'independent'].includes(mode) || !Number.isInteger(consumerCount) ||
  consumerCount < 1 || consumerCount > 8) throw new Error('Invalid benchmark arguments')
const size = (await stat(path)).size
const pages = arg('pages', '1,2,3,2,1').split(',').flatMap(part => {
  const [first, last] = part.split(':').map(Number)
  if (!Number.isInteger(first) || first < 1 || (last !== undefined && (!Number.isInteger(last) || last < 1))) {
    throw new Error('Invalid page sequence')
  }
  return last === undefined ? [first] : Array.from({ length: Math.abs(last - first) + 1 },
    (_, i) => first + i * Math.sign(last - first))
})
const samples: object[] = []
let peakRss = process.memoryUsage().rss
let rangeBytes = 0
const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
const handles: Awaited<ReturnType<typeof open>>[] = []
const loadingTasks: ReturnType<typeof pdfjs.getDocument>[] = []
async function openDocument(filePath: string, fileSize: number) {
  const handle = await open(filePath, 'r'); handles.push(handle)
  let rejectRange!: (error: unknown) => void
  const failure = new Promise<never>((_, reject) => { rejectRange = reject })
  class Range extends pdfjs.PDFDataRangeTransport {
    stopped = false
    constructor() { super(fileSize, new Uint8Array(), true) }
    requestDataRange(begin: number, end: number) {
      void (async () => {
        const data = new Uint8Array(end - begin)
        let offset = 0
        while (offset < data.length) {
          const { bytesRead } = await handle.read(data, offset, data.length - offset, begin + offset)
          if (!bytesRead) throw new Error('Short PDF range')
          offset += bytesRead
        }
        rangeBytes += data.byteLength
        if (!this.stopped) this.onDataRange(begin, data)
      })().catch(error => { if (!this.stopped) rejectRange(error) })
    }
    abort() { this.stopped = true }
  }
  const range = new Range()
  const task = pdfjs.getDocument({ range, length: fileSize, disableAutoFetch: true, disableStream: true,
    rangeChunkSize: 1024 * 1024, isImageDecoderSupported: false,
    standardFontDataUrl: `${dirname(require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`,
    cMapUrl: `${dirname(require.resolve('pdfjs-dist/package.json'))}/cmaps/`, cMapPacked: true })
  loadingTasks.push(task)
  try { return await Promise.race([task.promise, failure]) }
  catch (error) { range.abort(); await task.destroy(); throw error }
}
const secondarySize = secondary ? (await stat(secondary)).size : 0
const documents = [{ id: 'fixture-revision', size, open: () => openDocument(path, size) }]
if (secondary) documents.push({ id: 'preview-revision', size: secondarySize,
  open: () => openDocument(secondary, secondarySize) })
const backends = Array.from({ length: mode === 'shared' ? 1 : consumerCount }, () => new PdfFrameBackend(
  documents, () => createCanvas(1, 1) as HTMLCanvasElement))
const sources = backends.map(backend => new SlideFrameSource(backend, 64 * 1024 * 1024))
const started = performance.now()
let stoppedStats: object[] = []
try {
  for (const page of pages) {
    const start = performance.now()
    const hashes: string[] = []
    // Request all four concurrently; each receiver independently copies pixels
    // before releasing. This includes CPU-copy cost, not GPU delivery.
    await Promise.all(Array.from({ length: consumerCount }, async (_, i) => {
      const lease = await sources[mode === 'shared' ? 0 : i].request(`consumer-${i}`,
        { document: secondary && i === consumerCount - 1 ? 'preview-revision' : 'fixture-revision',
          page, width, height, rotation: 0 }, i === 0 ? 'program' : 'preview')
      if (!lease) throw new Error('Unexpected supersession')
      try {
        const pixels = lease.frame.pixels.slice()
        hashes[i] = createHash('sha256').update(pixels).digest('hex')
      } finally { lease.release() }
    }))
    if (new Set(secondary ? hashes.slice(0, -1) : hashes).size > 1) throw new Error('Consumer pixels differ')
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    samples.push({ page, ms: performance.now() - start, hashes, rss: process.memoryUsage().rss })
    console.log(`${mode} page ${page}: ${Math.round(performance.now() - start)} ms`)
  }
} finally {
  clearInterval(monitor)
  await Promise.all(sources.map(source => source.stop()))
  await Promise.all(loadingTasks.map(task => task.destroy()))
  await Promise.all(handles.map(handle => handle.close()))
  stoppedStats = sources.map(source => ({ ...source.stats, residentBytesAfterStop: source.residentBytes }))
}
const report = { runtime: process.version, pdfjs: pdfjs.version, platform: process.platform,
  model: 'Node PDF.js/native canvas, CPU copies; not Electron candidate or physical output',
  mode, size, secondarySize, width, height, consumerCount, elapsedMs: performance.now() - started, peakRss, rangeBytes,
  backends: backends.map(backend => backend.stats), sources: stoppedStats, samples }
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2))
console.log(`saved ${output}`)
