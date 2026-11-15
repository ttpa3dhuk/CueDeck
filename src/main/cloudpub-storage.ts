import { app } from 'electron'
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { CloudpubStore } from './cloudpub.js'

// Publication ownership only. Cloudpub credentials stay in Cloudpub's own configuration.
export const cloudpubStore: CloudpubStore = {
  async load() {
    try { return JSON.parse(await readFile(join(app.getPath('userData'), 'cloudpub-clicker.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  },
  async save(value) {
    const directory = app.getPath('userData'); await mkdir(directory, { recursive: true })
    const file = join(directory, 'cloudpub-clicker.json'); const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp'
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, file) }
    finally { await rm(temporary, { force: true }) }
  },
}
