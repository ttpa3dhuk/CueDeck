import { app, safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { link, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

let pending: Promise<string> | null = null

/** Separate from preferences/profiles/diagnostic exports; never return via state IPC. */
async function load(): Promise<string> {
  if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('Remote key encryption unavailable')
  }
  const file = join(app.getPath('userData'), 'remote-access-key.json')
  const read = async (): Promise<string> => {
    const record = JSON.parse(await readFile(file, 'utf8'))
    if (record.version !== 1 || typeof record.encrypted !== 'string') throw new Error('Invalid remote key storage')
    const key = safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'))
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid remote key')
    return key
  }
  try { return await read() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = randomBytes(32).toString('hex')
  const data = JSON.stringify({ version: 1, encrypted: safeStorage.encryptString(key).toString('base64') })
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(data); await handle.sync() }
    finally { await handle.close() }
    // Publish the complete file without replacing a key created by another process.
    try { await link(temporary, file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return await read()
      throw error
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return key
}

export function remoteAccessKey(): Promise<string> {
  if (!pending) pending = load().catch(error => { pending = null; throw error })
  return pending
}
