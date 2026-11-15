import { FramePortServer, type FramePort } from '../../../packages/render-core/src/frame-port'
import { createPdfFramePrototype } from '../shared/pdf-frame-prototype'
import type { PdfOwnerCommand, PdfOwnerReply } from '../../shared/pdf-frames'
import type { RenderDocumentInfo } from '../../../packages/render-core/src/kernel'

declare global { interface Window { pdfOwner: {
  ready(): void
  reply(value: PdfOwnerReply): void
  onCommand(callback: (command: PdfOwnerCommand) => void): void
} } }
const owner = createPdfFramePrototype([], 192 * 1024 * 1024)
const server = new FramePortServer((frame: import('../../render-backends/pdfjs').RgbaSlideFrame) =>
  frame.pixels.slice().buffer as ArrayBuffer, 128 * 1024 * 1024, 30000, 32)
const generation = server.pause()
server.resume(owner.frames, [], generation)
window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'cuedeck-pdf-owner-port' || !event.ports[0]) return
  const id = event.data.metadata?.id
  if (typeof id !== 'string') { event.ports[0].close(); return }
  server.detach(id)
  server.attach(id, event.ports[0] as unknown as FramePort)
})
let tail = Promise.resolve()
let documents: RenderDocumentInfo[] = []
async function handle(command: PdfOwnerCommand): Promise<unknown> {
  switch (command.type) {
    case 'sync': {
      const active = new Set(command.sources.map(source => source.id))
      server.updateDocuments(documents.filter(doc => active.has(doc.id)))
      documents = await owner.sync(command.sources)
      server.updateDocuments(documents)
      return documents
    }
    case 'describe': {
      const doc = await owner.frames.describe(command.id)
      return command.page === undefined ? doc : { ...doc, ...await owner.backend.pageInfo(command.id, command.page) }
    }
    case 'detach': server.detach(command.id); return null
    case 'stats': return { backend: owner.backend.stats, cache: owner.frames.stats,
      residentBytes: owner.frames.residentBytes, transport: server.stats, inFlightBytes: server.inFlightBytes }
  }
}
window.pdfOwner.onCommand(command => {
  const respond = async () => {
    try { window.pdfOwner.reply({ seq: command.seq, ok: true, value: await handle(command) }) }
    catch (error) { window.pdfOwner.reply({ seq: command.seq, ok: false, error: String(error) }) }
  }
  if (command.type === 'sync') tail = tail.then(respond)
  else void respond()
})
window.pdfOwner.ready()
