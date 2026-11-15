import { FramePortClient, FramePortServer, type FramePort } from '../../../packages/render-core/src/frame-port'
import type { SlideFrameKey } from '../../../packages/render-core/src/frame-source'

declare global {
  interface Window {
    renderQA: { config(): Promise<any>; ready(): void }
    qa: Record<string, any>
  }
}
const query = new URLSearchParams(location.search)
const role = query.get('role')!
const canvas = document.querySelector('canvas')!
const label = document.querySelector('header')!
label.textContent = `Render core QA · ${role}`
const config = await window.renderQA.config()
const hash = async () => {
  const bytes = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
}
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const keyFor = (document: string, page: number): SlideFrameKey => ({ document, page,
  width: config.width, height: config.height, rotation: 0 })

if (role === 'owner') {
  const { createPdfFramePrototype } = await import('../../../src/renderer/shared/pdf-frame-prototype')
  const server = new FramePortServer<any>((frame, key) => {
    return frame.pixels.slice().buffer as ArrayBuffer
  }, config.deliveryBytes, 90000)
  let owner: ReturnType<typeof createPdfFramePrototype> | null = null
  let replacement = Promise.resolve()
  async function replace(indices: number[]) {
    const generation = server.pause()
    const previous = owner; owner = null
    await previous?.stop()
    const sources = indices.map(index => config.documents[index])
    owner = createPdfFramePrototype(sources, config.cacheBytes)
    const documents = await Promise.all(sources.map(source => owner!.frames.describe(source.id)))
    server.resume(owner.frames, documents, generation)
    return documents
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.data?.kind === 'render-qa:port' && event.ports[0]) {
      server.attach(event.data.info.id, event.ports[0] as unknown as FramePort)
    }
  })
  window.qa = {
    snapshot: () => canvas.toDataURL('image/png'),
    replace: (indices: number[]) => { const result = replacement.then(() => replace(indices)); replacement = result.then(() => undefined); return result },
    stats: () => ({ transport: server.stats, inFlightBytes: server.inFlightBytes,
      backend: owner?.backend.stats, cache: owner?.frames.stats, residentBytes: owner?.frames.residentBytes }),
    stop: async () => { server.close(); await owner?.stop(); return window.qa.stats() },
  }
} else if (role === 'client') {
  let client: FramePortClient | null = null
  let heldAck: { message: unknown; buffers?: ArrayBuffer[] } | null = null
  let delayAck = false
  let delayFrames = false
  const heldFrames: MessageEvent[] = []
  let native: MessagePort | null = null
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.kind !== 'render-qa:port' || !event.ports[0]) return
    native = event.ports[0]
    const port: FramePort = {
      onmessage: null, onmessageerror: null,
      postMessage: (message: any, buffers?: ArrayBuffer[]) => {
        if (delayAck && message.type === 'ack') heldAck = { message, buffers }
        else native!.postMessage(message, buffers ?? [])
      },
      start() { native!.onmessage = event => { if (delayFrames && event.data?.type === 'frame') heldFrames.push(event); else port.onmessage?.(event) }; native!.onmessageerror = () => port.onmessageerror?.(); native!.start() },
      close() { native!.close() },
    }
    client = new FramePortClient(port, (buffer, key) => {
      canvas.width = key.width; canvas.height = key.height
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(buffer), key.width, key.height), 0, 0)
    })
  })
  window.qa = {
    snapshot: () => canvas.toDataURL('image/png'),
    ready: () => !!client?.documents.length,
    request: async (document: string, page: number) => {
      const start = performance.now()
      const painted = await client!.request(keyFor(document, page), query.get('id') === '0' ? 'program' : 'preview')
      const readyMs = performance.now() - start
      await settled()
      return { painted, page, readyMs, ms: performance.now() - start, hash: painted ? await hash() : null }
    },
    sized: async (document: string, page: number, width: number, height: number) => {
      const painted = await client!.request({ ...keyFor(document, page), width, height }, 'program'); await settled();
      return { painted, width: canvas.width, height: canvas.height, hash: await hash() }
    },
    burst: async (document: string, pages: number[]) => {
      const results = await Promise.all(pages.map(page => client!.request(keyFor(document, page), 'program')))
      await settled()
      return { results, hash: await hash(), stats: client!.stats }
    },
    delayFrames: () => { delayFrames = true },
    releaseFrames: () => { delayFrames = false; for (const event of heldFrames.splice(0)) native!.onmessage!(event) },
    delayAck: () => { delayAck = true },
    releaseAck: () => { delayAck = false; if (heldAck) { native!.postMessage(heldAck.message, heldAck.buffers ?? []); heldAck = null } },
    stats: () => ({ ...client?.stats, generation: client?.generation, documents: client?.documents,
      heldFrames: heldFrames.length, canvasBytes: canvas.width * canvas.height * 4 }),
    hash,
    close: () => client?.close(),
  }
} else if (role === 'baseline') {
  // Exact candidate loader, imported only by baseline windows. Shared consumers
  // load neither PDF.js nor the loader/backend chunks.
  const { PdfLoader } = await import('../../../src/renderer/shared/pdf-loader')
  let loader = new PdfLoader()
  let documentId = ''
  const scratch = document.createElement('canvas')
  window.qa = {
    snapshot: () => canvas.toDataURL('image/png'),
    request: async (document: string, page: number) => {
      const start = performance.now()
      if (documentId !== document) {
        const source = config.documents.find((source: any) => source.id === document)
        await loader.loadDocument(source.file); documentId = document
      }
      await loader.renderPageTo(page, scratch, config.width / Math.min(devicePixelRatio || 1, 2))
      canvas.width = config.width; canvas.height = config.height
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(canvas.width / scratch.width, canvas.height / scratch.height)
      ctx.drawImage(scratch, (canvas.width - scratch.width * scale) / 2,
        (canvas.height - scratch.height * scale) / 2, scratch.width * scale, scratch.height * scale)
      const readyMs = performance.now() - start
      await settled()
      return { painted: true, page, readyMs, ms: performance.now() - start, hash: await hash() }
    },
    stats: () => ({ documentId }),
    stop: async () => { await loader.getDocument()?.destroy(); loader = new PdfLoader(); documentId = ''; scratch.width = 0; scratch.height = 0 },
  }
}
window.renderQA.ready()
