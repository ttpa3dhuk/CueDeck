import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { PlaylistEntry } from './state.js'

export const PROJECT_SCHEMA_VERSION = 1
export const PROJECT_EXTENSION = 'pdpres'

export interface ProjectFile {
  schemaVersion: number
  createdAt: string
  updatedAt: string
  playlist: PlaylistEntry[]
  keyVisualPath: string | null
}

export interface LoadedProject {
  playlist: PlaylistEntry[]
  keyVisualPath: string | null
}

function migrateEntry(raw: unknown): PlaylistEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const filePath = String(v.filePath ?? v.pdfPath ?? '')
  if (!filePath) return null
  return {
    id: String(v.id ?? cryptoRandomId()),
    kind: (v.kind as PlaylistEntry['kind']) ?? 'pdf',
    filePath,
    fileName: String(v.fileName ?? v.pdfName ?? basename(filePath)),
    speakerName: String(v.speakerName ?? ''),
    durationMs: Number(v.durationMs ?? 30 * 60 * 1000),
  }
}

function cryptoRandomId(): string {
  return Array.from({ length: 8 })
    .map(() => Math.random().toString(36).slice(2, 6))
    .join('')
}

export async function loadProjectFile(path: string): Promise<LoadedProject> {
  const raw = await readFile(path, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<ProjectFile>
  const playlist = Array.isArray(parsed.playlist)
    ? (parsed.playlist
        .map(migrateEntry)
        .filter((e): e is PlaylistEntry => e !== null))
    : []
  return {
    playlist,
    keyVisualPath:
      typeof parsed.keyVisualPath === 'string' ? parsed.keyVisualPath : null,
  }
}

export async function saveProjectFile(
  path: string,
  data: { playlist: PlaylistEntry[]; keyVisualPath: string | null },
): Promise<void> {
  const project: ProjectFile = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    playlist: data.playlist,
    keyVisualPath: data.keyVisualPath,
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(project, null, 2), 'utf-8')
  await rename(tmp, path)
}
