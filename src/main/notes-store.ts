import { createHash } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'

const SCHEMA_VERSION = 1
const WRITE_DEBOUNCE_MS = 500

export interface NotesFile {
  version: number
  pdfSha1: string
  updatedAt: string
  notes: Record<number, string>
}

export interface LoadedNotes {
  notes: Record<number, string>
  sha1Mismatch: boolean
  storedSha1: string | null
}

export function sidecarPathFor(pdfPath: string): string {
  const parsed = parse(pdfPath)
  return join(dirname(pdfPath), `${parsed.name}.notes.json`)
}

export async function computePdfSha1(pdfPath: string): Promise<string> {
  const buf = await readFile(pdfPath)
  return createHash('sha1').update(buf).digest('hex')
}

/** Compute SHA1 from an already-loaded buffer — avoids a second disk read. */
export function sha1FromBuffer(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}

/**
 * Lightweight content-identity hash from path + size + mtime, without reading
 * the file. Used for video, where files can be multi-GB and hashing the full
 * contents would be wasteful — we only need a stable id for the media URL.
 */
export async function computeStatSha1(filePath: string): Promise<string> {
  const st = await stat(filePath)
  return createHash('sha1')
    .update(`${filePath}:${st.size}:${st.mtimeMs}`)
    .digest('hex')
}

export async function loadNotes(pdfPath: string, currentSha1: string): Promise<LoadedNotes> {
  const sidecarPath = sidecarPathFor(pdfPath)
  try {
    const raw = await readFile(sidecarPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<NotesFile>
    const notes: Record<number, string> = {}
    if (parsed.notes && typeof parsed.notes === 'object') {
      for (const [k, v] of Object.entries(parsed.notes)) {
        const idx = Number(k)
        if (Number.isInteger(idx) && typeof v === 'string') notes[idx] = v
      }
    }
    return {
      notes,
      sha1Mismatch: parsed.pdfSha1 !== currentSha1,
      storedSha1: parsed.pdfSha1 ?? null,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { notes: {}, sha1Mismatch: false, storedSha1: null }
    }
    throw err
  }
}

class NotesWriter {
  private pending: { pdfPath: string; sha1: string; notes: Record<number, string> } | null = null
  private timer: NodeJS.Timeout | null = null

  schedule(pdfPath: string, sha1: string, notes: Record<number, string>): void {
    this.pending = { pdfPath, sha1, notes }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS)
  }

  async flush(): Promise<void> {
    if (!this.pending) return
    const { pdfPath, sha1, notes } = this.pending
    this.pending = null
    this.timer = null

    const sidecarPath = sidecarPathFor(pdfPath)
    const payload: NotesFile = {
      version: SCHEMA_VERSION,
      pdfSha1: sha1,
      updatedAt: new Date().toISOString(),
      notes,
    }
    const tmp = `${sidecarPath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    await rename(tmp, sidecarPath)
  }
}

export const notesWriter = new NotesWriter()
