import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { SharedPdfSource } from '../shared/pdf-frames'

export interface PdfDeckSource { path: string; sha1: string }
interface RecordEntry extends SharedPdfSource { path: string; sha1: string; mtimeMs: number }

/** File capabilities are independent of program/preview roles, so TAKE does not
 * invalidate a warmed document. Only the host can register a source path. */
export class SharedPdfRegistry {
  private records = new Map<string, RecordEntry>()
  private sourceKey(source: PdfDeckSource): string { return JSON.stringify([source.path, source.sha1]) }

  async reconcile(sources: PdfDeckSource[], onFailure?: (source: PdfDeckSource, error: unknown) => void): Promise<SharedPdfSource[]> {
    const wanted = new Map(sources.map(source => [this.sourceKey(source), source]))
    if (wanted.size > 2) throw new Error('Too many active PDF documents')
    const next = new Map<string, RecordEntry>()
    for (const [key, source] of wanted) {
      try {
      const info = await stat(source.path)
      if (!info.isFile()) throw new Error('PDF source is not a file')
      const current = this.records.get(key)
      if (current && (current.file.size !== info.size || current.mtimeMs !== info.mtimeMs)) {
        throw new Error('PDF changed on disk; reopen the document')
      }
      const id = current?.id ?? createHash('sha256').update(JSON.stringify([source.path, source.sha1, info.size, info.mtimeMs])).digest('hex')
      next.set(key, current ?? { ...source, id, mtimeMs: info.mtimeMs,
        file: { url: `cuedeck-media://pdf-source/${id}`, size: info.size } })
      } catch (error) {
        if (!onFailure) throw error
        onFailure(source, error)
      }
    }
    this.records = next
    return this.sources()
  }

  sources(): SharedPdfSource[] {
    return [...this.records.values()].map(({ id, file }) => ({ id, file: { ...file } }))
  }
  get(source: PdfDeckSource): SharedPdfSource | undefined {
    const record = this.records.get(this.sourceKey(source))
    return record ? { id: record.id, file: { ...record.file } } : undefined
  }
  has(id: string): boolean { return [...this.records.values()].some(record => record.id === id) }
  async resolve(url: URL): Promise<string | null> {
    if (url.hostname !== 'pdf-source' || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return null
    const record = [...this.records.values()].find(record => record.id === url.pathname.slice(1))
    if (!record) return null
    const info = await stat(record.path).catch(() => null)
    return info?.size === record.file.size && info.mtimeMs === record.mtimeMs ? record.path : null
  }
}
