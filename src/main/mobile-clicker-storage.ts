import { app, safeStorage } from 'electron'
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface MobileClickerRecord { key: string; port: number; enabled: boolean }
export interface MobileClickerStorage {
  load(): Promise<MobileClickerRecord | null>
  save(record: MobileClickerRecord): Promise<void>
}

/** Machine-local credential, excluded from project/profile/state exports. */
export const mobileClickerStorage: MobileClickerStorage = {
  async load() {
    const file = join(app.getPath('userData'), 'mobile-clicker-access.json')
    let data: string
    try { data = await readFile(file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const saved = JSON.parse(data)
    const key = safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64'))
    if (saved.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(key) || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535 || typeof saved.enabled !== 'boolean') throw Error('Invalid mobile clicker storage')
    return { key, port: saved.port, enabled: saved.enabled }
  },
  async save(record) {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw Error('Mobile clicker encryption unavailable')
    const directory = app.getPath('userData')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'mobile-clicker-access.json')
    const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp'
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: 1, encrypted: safeStorage.encryptString(record.key).toString('base64'), port: record.port, enabled: record.enabled })); await handle.sync() }
      finally { await handle.close() }
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  },
}
