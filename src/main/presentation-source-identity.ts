import { stat } from 'node:fs/promises'
import type { SourceIdentity } from '../shared/presentation-preparation.js'

export async function sourceIdentity(filePath: string): Promise<SourceIdentity> {
  const info = await stat(filePath, { bigint: true })
  return {
    dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
  }
}
