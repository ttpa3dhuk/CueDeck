import { readFile, stat } from 'node:fs/promises'
import type { DeckFileData } from '../shared/pdf-source'

export const PDF_RANGE_THRESHOLD = 64 * 1024 * 1024

export async function readDeckFile(path: string, mime: string, url: string): Promise<DeckFileData> {
  if (mime === 'application/pdf') {
    const { size } = await stat(path)
    if (size >= PDF_RANGE_THRESHOLD) return { bytes: new Uint8Array(), mime, pdf: { url, size } }
  }
  const bytes = await readFile(path)
  return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime }
}

interface Deck { path: string | null; kind: string | null; sha1: string | null }

/** Resolve only a currently open deck, identified by its existing content hash. */
export function resolvePdfDocument(url: URL, program: Deck, preview: Deck, cached: (sha1: string) => string): string | null {
  if (url.hostname !== 'document') return null
  const deck = url.pathname === '/program' ? program : url.pathname === '/preview' ? preview : null
  if (!deck?.path || !deck.sha1 || url.searchParams.get('v') !== deck.sha1) return null
  if (deck.kind === 'pdf') return deck.path
  if (deck.kind === 'pptx') return cached(deck.sha1)
  return null
}
