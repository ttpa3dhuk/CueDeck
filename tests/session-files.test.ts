import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const h = vi.hoisted(() => ({ folder: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.folder } }))
import { listSessionBackups, newSession, readLastSession, readSessionBackup, writeNewSession, writeSession, writeSessionBackup } from '../src/main/session-files'
import type { SessionCheckpoint } from '../src/shared/startup-settings'
const snapshot = { playlist: [], projectPath: null } as unknown as SessionCheckpoint
beforeEach(() => { h.folder = mkdtempSync(join(tmpdir(), 'cue-session-')); newSession() })
afterEach(() => { rmSync(h.folder, { recursive: true, force: true }) })
it('keeps the last real session when a new empty session begins and restores its identity', () => {
  writeSession(snapshot)
  const pointer = JSON.parse(readFileSync(join(h.folder, 'sessions', 'last.json'), 'utf8'))
  newSession()
  expect(readLastSession()).toEqual(snapshot)
  writeSession({ ...snapshot, projectPath: '/show.pdpres' })
  expect(JSON.parse(readFileSync(join(h.folder, 'sessions', 'last.json'), 'utf8')).id).toBe(pointer.id)
})
it('retains only ten independent interval backups', () => {
  writeSession(snapshot)
  for (let i = 0; i < 12; i++) writeSessionBackup({ ...snapshot, projectPath: String(i) })
  const files = readdirSync(join(h.folder, 'sessions')).filter(file => file.includes('-backup-'))
  expect(files).toHaveLength(10)
  expect(new Set(files.map(file => JSON.parse(readFileSync(join(h.folder, 'sessions', file), 'utf8')).checkpoint.projectPath)).size).toBe(10)
})
it('reports a missing session file instead of silently falling back to older data', () => {
  writeSession(snapshot)
  const pointer = JSON.parse(readFileSync(join(h.folder, 'sessions', 'last.json'), 'utf8'))
  unlinkSync(join(h.folder, 'sessions', pointer.file))
  expect(() => readLastSession()).toThrow()
})

it('creates a new empty session without replacing Last and makes backups selectable', () => {
  writeSession(snapshot)
  const last = JSON.parse(readFileSync(join(h.folder, 'sessions', 'last.json'), 'utf8')).id
  newSession()
  writeNewSession(snapshot)
  expect(JSON.parse(readFileSync(join(h.folder, 'sessions', 'last.json'), 'utf8')).id).toBe(last)
  writeSessionBackup({ ...snapshot, projectPath: '/unsaved' })
  const choices = listSessionBackups()
  expect(choices).toHaveLength(1)
  expect(readSessionBackup(choices[0].id).projectPath).toBe('/unsaved')
  expect(() => readSessionBackup('../last.json')).toThrow()
})
