import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { t } from '../shared/i18n.js'
import type { ReportMaterials } from '../shared/types.js'

// The existing ZIP writer holds its inputs and compressed output in memory.
export const REPORT_MATERIAL_LIMIT = 128 * 1024 * 1024
interface SelectedFile { path: string; name: string; bytes: number; modified: number }

/** Only files explicitly selected through the native picker can be attached. */
export class ReportMaterialSelection {
  private selection: { token: string; files: SelectedFile[] } | null = null

  clear(): void { this.selection = null }

  async select(paths: string[]): Promise<ReportMaterials> {
    this.clear()
    const unique = [...new Set(paths)]
    if (unique.length > 100) throw new Error(t('Можно приложить не больше 100 файлов.'))
    const files: SelectedFile[] = []
    let bytes = 0
    for (const path of unique) {
      const info = await stat(path)
      if (!info.isFile()) throw new Error(t('Выберите файлы, а не папки.'))
      bytes += info.size
      if (bytes > REPORT_MATERIAL_LIMIT) throw new Error(t('Материалы больше 128 МиБ. Выберите меньше файлов или отправьте большой файл отдельно.'))
      files.push({ path, name: basename(path), bytes: info.size, modified: info.mtimeMs })
    }
    const token = randomUUID()
    this.selection = { token, files }
    return { token, files: files.map(({ name, bytes }) => ({ name, bytes })), bytes }
  }

  async read(token: string): Promise<{ name: string; data: Buffer }[]> {
    const selection = this.selection
    if (!selection || token !== selection.token) throw new Error(t('Выберите материалы для отчёта заново.'))
    const result: { name: string; data: Buffer }[] = []
    for (const [index, file] of selection.files.entries()) {
      const handle = await open(file.path, 'r')
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size !== file.bytes || before.mtimeMs !== file.modified) {
          throw new Error(t('Материалы изменились после выбора. Выберите файлы заново.'))
        }
        // Bounded read: a growing file cannot exceed the approved memory budget.
        const data = Buffer.alloc(file.bytes)
        let offset = 0
        while (offset < data.length) {
          const read = await handle.read(data, offset, data.length - offset, offset)
          if (!read.bytesRead) throw new Error(t('Материалы изменились после выбора. Выберите файлы заново.'))
          offset += read.bytesRead
        }
        const after = await handle.stat()
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error(t('Материалы изменились после выбора. Выберите файлы заново.'))
        }
        // Separate numbered folders preserve duplicate basenames and Unicode.
        const safeName = file.name.replace(/[\\/\x00-\x1f]/g, '_') || 'file'
        result.push({ name: `materials/${index + 1}/${safeName}`, data })
      } finally { await handle.close() }
    }
    return result
  }
}
