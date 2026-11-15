/** Opt-in owner adapter only; deliberately not imported by application entries. */
import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PdfFrameBackend } from '../../render-backends/pdfjs'
import { RenderKernel } from '../../../packages/render-core/src/kernel'
import type { PdfFileSource } from '../../shared/pdf-source'
import { LocalPdfRangeTransport } from './pdf-range-transport'
import { pdfImageDecoderOption } from './pdf-image-decoder'

export function createPdfFramePrototype(sources: { id: string; file: PdfFileSource }[], budget?: number) {
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
  type Source = { id: string; file: PdfFileSource }
  const snapshot = (source: Source): Source => ({ id: source.id, file: { ...source.file } })
  const registered = new Map(sources.map(source => { const copy = snapshot(source); return [copy.id, copy] }))
  const tasks = new Map<string, ReturnType<typeof pdfjs.getDocument>>()
  let stopping = false
  const specification = (source: Source) => {
    const { id, file } = source
    return { id, size: file.size,
    open: async () => {
      if (stopping || registered.get(id) !== source) throw new Error('PDF frame owner stopped or revision retired')
      const range = new LocalPdfRangeTransport(file)
      const task = pdfjs.getDocument({ range, length: file.size, disableAutoFetch: true, disableStream: true,
        rangeChunkSize: 1024 * 1024,
        isImageDecoderSupported: pdfImageDecoderOption(navigator.userAgent,
          typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function') })
      tasks.set(id, task)
      // Range failure can happen long after the header promise has resolved.
      // Kill the worker so waiting getPage/render calls reject instead of hang.
      void range.failure.catch(() => { void task.destroy().catch(() => undefined) })
      try { return await Promise.race([task.promise, range.failure]) }
      catch (error) { range.abort(); await task.destroy(); if (tasks.get(id) === task) tasks.delete(id); throw error }
    } }
  }
  // Validate duplicates before Map normalization could hide them.
  if (registered.size !== sources.length) throw new Error('Duplicate PDF revision')
  const backend = new PdfFrameBackend([...registered.values()].map(specification))
  const frames = new RenderKernel(backend, { cacheBytes: budget })
  return { frames, backend,
    sync: async (next: Source[]) => {
      if (stopping || next.length > 2 || new Set(next.map(source => source.id)).size !== next.length) throw new Error('Invalid PDF document set')
      for (const source of next) {
        const current = registered.get(source.id)
        if (current && (current.file.url !== source.file.url || current.file.size !== source.file.size)) throw new Error('PDF revision identity cannot change')
      }
      const wanted = new Set(next.map(source => source.id))
      for (const id of [...registered.keys()]) if (!wanted.has(id)) {
        registered.delete(id)
        frames.invalidateDocument(id)
        await tasks.get(id)?.destroy()
        tasks.delete(id)
        await backend.retire(id)
      }
      if (stopping) throw new Error('PDF frame owner stopped')
      for (const input of next) if (!registered.has(input.id)) {
        const source = snapshot(input)
        registered.set(source.id, source)
        backend.addSource(specification(source))
      }
      return Promise.all(next.map(source => frames.describe(source.id)))
    },
    // Destroy a still-opening task first so stop cannot wait forever for it.
    stop: async () => {
      stopping = true
      const stopped = frames.stop()
      await Promise.all([...tasks.values()].map(task => task.destroy()))
      await stopped
      tasks.clear()
    } }
}
