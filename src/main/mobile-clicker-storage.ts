import { app, safeStorage } from 'electron'
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface MobileClickerRecord { key: string; port: number; cloudPort?: number; enabled: boolean; access?: import('../shared/mobile-clicker').ClickerAccess }
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
    if (saved.cloudPort !== undefined && (!Number.isInteger(saved.cloudPort) || saved.cloudPort < 1024 || saved.cloudPort > 65535)) throw Error('Invalid cloud port')
    let access: import('../shared/mobile-clicker').ClickerAccess | undefined
    if (saved.access) {
      access = JSON.parse(safeStorage.decryptString(Buffer.from(saved.access, 'base64')))
      if (!access || typeof access.online !== 'boolean' || typeof access.publicUrl !== 'string' || !Array.isArray(access.grants) || access.grants.length > 64 || access.grants.some(g => typeof g.id !== 'string' || typeof g.name !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(g.key) || (g.presentations !== null && (!Array.isArray(g.presentations) || g.presentations.some(id => typeof id !== 'string'))))) throw Error('Invalid mobile clicker access')
      if (access.online && new URL(access.publicUrl).protocol !== 'https:') throw Error('Invalid mobile clicker URL')
      if (access.guestOpen !== undefined && typeof access.guestOpen !== 'boolean') throw Error('Invalid guest policy')
      if (access.guestPresentations !== undefined && access.guestPresentations !== null && (!Array.isArray(access.guestPresentations) || access.guestPresentations.length > 500 || access.guestPresentations.some(id => typeof id !== 'string' || !id || id.length > 200))) throw Error('Invalid guest scope')
      if (access.guestOpen && access.guestPresentations !== null && !access.guestPresentations?.length) throw Error('Missing guest scope')
    }
    return { key, port: saved.port, cloudPort: saved.cloudPort, enabled: saved.enabled, access }
  },
  async save(record) {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw Error('Mobile clicker encryption unavailable')
    const directory = app.getPath('userData')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'mobile-clicker-access.json')
    const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp'
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: 1, access: record.access ? safeStorage.encryptString(JSON.stringify(record.access)).toString('base64') : undefined, encrypted: safeStorage.encryptString(record.key).toString('base64'), port: record.port, cloudPort: record.cloudPort, enabled: record.enabled })); await handle.sync() }
      finally { await handle.close() }
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  },
}
