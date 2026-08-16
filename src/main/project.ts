import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isLiveUri } from '../shared/live.js'
import type { PlaylistEntry } from './state.js'

/** 2 — пути к материалам внутри папки проекта пишутся относительными. */
export const PROJECT_SCHEMA_VERSION = 2
export const PROJECT_EXTENSION = 'pdpres'

/**
 * Путь для записи в файл проекта. Материал, лежащий рядом с .pdpres (в той же
 * папке или её подпапках), сохраняется **относительным** — тогда папку проекта
 * можно унести на флешке на другую машину и даже в другую ОС, и пути не
 * рассыплются. Всё, что лежит выше или на другом диске, остаётся абсолютным.
 *
 * Разделитель в относительных путях всегда `/`: проект, сохранённый на Windows,
 * должен открываться на маке. `resolve()` при чтении понимает оба.
 * Живые входы (`live://…`) — не файлы, их не трогаем.
 */
export function toStoredPath(filePath: string, projectPath: string): string {
  if (!filePath || isLiveUri(filePath)) return filePath
  if (!isAbsolute(filePath)) return filePath
  const rel = relative(dirname(projectPath), filePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return filePath
  return rel.split(sep).join('/')
}

/** Обратное преобразование: относительный путь разворачивается от папки проекта. */
export function fromStoredPath(stored: string, projectPath: string): string {
  if (!stored || isLiveUri(stored) || isAbsolute(stored)) return stored
  return resolve(dirname(projectPath), stored)
}

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
    displayName: String(v.displayName ?? ''),
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
        .filter((e): e is PlaylistEntry => e !== null)
        .map((e) => ({ ...e, filePath: fromStoredPath(e.filePath, path) })))
    : []
  const keyVisual =
    typeof parsed.keyVisualPath === 'string' ? parsed.keyVisualPath : null
  return {
    playlist,
    keyVisualPath: keyVisual ? fromStoredPath(keyVisual, path) : null,
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
    playlist: data.playlist.map((e) => ({
      ...e,
      filePath: toStoredPath(e.filePath, path),
    })),
    keyVisualPath: data.keyVisualPath
      ? toStoredPath(data.keyVisualPath, path)
      : data.keyVisualPath,
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(project, null, 2), 'utf-8')
  await rename(tmp, path)
}
