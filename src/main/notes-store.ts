import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

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
  const pending = notesWriter.pendingNotes(pdfPath, currentSha1)
  if (pending) return pending
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

export class NotesWriter {
  private pending = new Map<string, { sha1: string; notes: Record<number, string> }>()
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null

  schedule(pdfPath: string, sha1: string, notes: Record<number, string>): void {
    this.pending.set(resolve(sidecarPathFor(pdfPath)), { sha1, notes: { ...notes } })
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush().catch(error => console.error('[notes] save failed:', error))
    }, WRITE_DEBOUNCE_MS)
  }

  pendingNotes(pdfPath: string, currentSha1: string): LoadedNotes | null {
    const entry = this.pending.get(resolve(sidecarPathFor(pdfPath)))
    return entry ? { notes: { ...entry.notes }, sha1Mismatch: entry.sha1 !== currentSha1, storedSha1: entry.sha1 } : null
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.inFlight && this.pending.size > 0) {
      this.inFlight = this.drain().finally(() => { this.inFlight = null })
    }
    await this.inFlight
    // Also cover an edit queued between the drain finishing and its promise settling.
    if (this.pending.size > 0) await this.flush()
  }

  private async drain(): Promise<void> {
    const failed = new Set<string>()
    const errors: unknown[] = []
    while (this.pending.size > 0) {
      const next = [...this.pending].find(([path]) => !failed.has(path))
      if (!next) break
      const [sidecarPath, entry] = next
      const payload: NotesFile = { version: SCHEMA_VERSION, pdfSha1: entry.sha1,
        updatedAt: new Date().toISOString(), notes: entry.notes }
      const tmp = `${sidecarPath}.tmp-${process.pid}-${randomUUID()}`
      try {
        await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
        await rename(tmp, sidecarPath)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined)
        // A read-only material must not block notes for unrelated documents.
        // Keep failed data available for retry and report the error to flush().
        failed.add(sidecarPath)
        errors.push(error)
        continue
      }
      if (this.pending.get(sidecarPath) === entry) this.pending.delete(sidecarPath)
    }
    if (errors.length) throw new AggregateError(errors, 'Could not save material notes')
  }
}

export const notesWriter = new NotesWriter()
