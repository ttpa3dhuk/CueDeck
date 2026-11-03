import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionCheckpoint } from '../shared/startup-settings.js'

interface SessionFile { version: 1; id: string; name: string; createdAt: string; checkpoint: SessionCheckpoint }
let current: Omit<SessionFile, 'checkpoint'> | undefined
let backupSequence = 0
const directory = (): string => join(app.getPath('userData'), 'sessions')
const sessionName = (session: Omit<SessionFile, 'checkpoint'>): string => `New Session ${session.createdAt.replace(/[:.]/g, '-')} ${session.id}.json`
function atomicWrite(path: string, value: unknown): void {
  mkdirSync(directory(), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(temp, JSON.stringify(value), 'utf8'); renameSync(temp, path) }
  finally { try { unlinkSync(temp) } catch { /* already renamed */ } }
}
export function newSession(): void {
  const createdAt = new Date().toISOString()
  current = { version: 1, id: randomUUID(), name: `New Session ${createdAt}`, createdAt }
}
export function writeNewSession(checkpoint: SessionCheckpoint): void {
  if (!current) newSession()
  atomicWrite(join(directory(), sessionName(current!)), { ...current!, checkpoint })
}
export function writeSession(checkpoint: SessionCheckpoint): void {
  if (!current) newSession()
  const record: SessionFile = { ...current!, checkpoint }
  atomicWrite(join(directory(), sessionName(record)), record)
  atomicWrite(join(directory(), 'last.json'), { id: record.id, file: sessionName(record) })
}
export function hasLastSession(): boolean { return existsSync(join(directory(), 'last.json')) }
export function readLastSession(): SessionCheckpoint | undefined {
  let pointer: { id?: unknown; file?: unknown }
  try { pointer = JSON.parse(readFileSync(join(directory(), 'last.json'), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (typeof pointer.id !== 'string' || !/^[0-9a-f-]{36}$/.test(pointer.id)) throw new Error('Invalid session ID')
  const file = pointer.file === undefined ? `${pointer.id}.json` : pointer.file
  if (typeof file !== 'string' || !(file === `${pointer.id}.json` || /^New Session [0-9TZ-]+ [0-9a-f-]{36}\.json$/.test(file)) || !file.endsWith(`${pointer.id}.json`)) throw new Error('Invalid session filename')
  const record = JSON.parse(readFileSync(join(directory(), file), 'utf8')) as SessionFile
  if (record.version !== 1 || record.id !== pointer.id || !record.checkpoint || !Array.isArray(record.checkpoint.playlist)) throw new Error('Invalid session file')
  current = { version: 1, id: record.id, name: record.name, createdAt: record.createdAt }
  return record.checkpoint
}
export function writeSessionBackup(checkpoint: SessionCheckpoint): void {
  if (!current) newSession()
  const prefix = `${current!.id}-backup-`
  const name = `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}-${String(backupSequence++).padStart(8, '0')}-${randomUUID()}.json`
  atomicWrite(join(directory(), name), { ...current!, checkpoint })
  const backups = readdirSync(directory()).filter(file => file.startsWith(prefix) && file.endsWith('.json')).sort().reverse()
  for (const file of backups.slice(10)) unlinkSync(join(directory(), file))
}

export function listSessionBackups(): Array<{ id: string; name: string; time: number }> {
  let files: string[]
  try { files = readdirSync(directory()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return files.filter(file => /^[0-9a-f-]{36}-backup-[0-9TZ-]+-[0-9]{8}-[0-9a-f-]{36}\.json$/.test(file))
    .map(id => ({ id, time: statSync(join(directory(), id)).mtimeMs }))
    .sort((a, b) => b.time - a.time).slice(0, 10)
    .map(item => ({ ...item, name: new Date(item.time).toLocaleString() }))
}
export function readSessionBackup(id: string): SessionCheckpoint {
  if (!listSessionBackups().some(item => item.id === id)) throw new Error('Backup unavailable')
  const record = JSON.parse(readFileSync(join(directory(), id), 'utf8')) as SessionFile
  if (record.version !== 1 || !record.checkpoint || !Array.isArray(record.checkpoint.playlist)) throw new Error('Invalid backup')
  return record.checkpoint
}
