import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PlaylistEntry, ProjectTransferStatus } from '../shared/types.js'
import { t } from '../shared/i18n.js'
import { loadProjectFile, PROJECT_EXTENSION, saveProjectFile } from './project.js'
import { uniqueName } from './project-files.js'
import { sidecarPathFor } from './notes-store.js'

let running = false
export function beginProjectTransfer(): boolean {
  if (running) return false
  running = true
  return true
}
export function endProjectTransfer(): void { running = false }
export function isProjectTransferRunning(): boolean { return running }

export interface TransferFile { source: string; target: string; checksum?: string }

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyTransferFile(file: TransferFile): Promise<void> {
  const [source, target] = await Promise.all([file.checksum ?? digest(file.source), digest(file.target)])
  if (source !== target) throw new Error(t('Проверка копии не прошла: {file}', { file: basename(file.target) }))
}

/** Build a snapshot in a staging folder; expose its project only after verification. */
export async function transferProject(opts: {
  parent: string
  name: string
  playlist: PlaylistEntry[]
  keyVisualPath: string | null
  prepare(source: string, target: string, directory: string): Promise<TransferFile[]>
  progress(status: ProjectTransferStatus): void
}): Promise<{ path: string; copied: number }> {
  const snapshot = structuredClone({ playlist: opts.playlist, keyVisualPath: opts.keyVisualPath })
  const sources = new Set<string>()
  for (const entry of snapshot.playlist) {
    if (entry.kind === 'live') continue
    if (entry.kind === 'list') for (const item of entry.items ?? []) sources.add(item.path)
    else sources.add(entry.filePath)
  }
  if (snapshot.keyVisualPath) sources.add(snapshot.keyVisualPath)
  // Notes are small and edited by the operator: freeze them before the slow copy.
  const notesSnapshot = new Map<string, Buffer>()
  for (const source of sources) {
    try { notesSnapshot.set(source, await readFile(sidecarPathFor(source))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const stage = await mkdtemp(join(opts.parent, `${opts.name}.building-`))
  const mediaDir = join(stage, t('материалы'))
  const copies = new Map<string, string>()
  const check: TransferFile[] = []
  const taken = new Set<string>()
  let published = false
  try {
    await mkdir(mediaDir)
    for (const source of sources) {
      const file = basename(source)
      opts.progress({ phase: 'copying', completed: copies.size, total: sources.size, file })
      const target = join(mediaDir, uniqueName(file, taken))
      await copyFile(source, target)
      check.push({ source, target })
      opts.progress({ phase: 'preparing', completed: copies.size, total: sources.size, file })
      check.push(...await opts.prepare(source, target, stage))
      const notes = sidecarPathFor(source)
      const noteBytes = notesSnapshot.get(source)
      if (noteBytes) {
        const targetNotes = sidecarPathFor(target)
        await writeFile(targetNotes, noteBytes)
        check.push({ source: notes, target: targetNotes, checksum: createHash('sha256').update(noteBytes).digest('hex') })
      }
      copies.set(source, target)
    }
    const playlist = snapshot.playlist.map((entry) => {
      if (entry.kind === 'live') return entry
      if (entry.kind === 'list') return { ...entry, items: entry.items?.map((item) => ({ ...item, path: copies.get(item.path)! })) }
      return { ...entry, filePath: copies.get(entry.filePath)! }
    })
    const keyVisualPath = snapshot.keyVisualPath ? copies.get(snapshot.keyVisualPath)! : null
    for (let i = 0; i < check.length; i++) {
      opts.progress({ phase: 'checking', completed: i, total: check.length, file: basename(check[i].target) })
      await verifyTransferFile(check[i])
    }
    const projectFile = `${opts.name}.${PROJECT_EXTENSION}`
    const stagedProject = join(stage, projectFile)
    await saveProjectFile(stagedProject, { playlist, keyVisualPath })
    const loaded = await loadProjectFile(stagedProject)
    const identity = (entries: PlaylistEntry[]): string => JSON.stringify(entries.map((entry) => ({
      id: entry.id, path: entry.filePath, items: entry.items?.map((item) => item.path),
    })))
    if (identity(loaded.playlist) !== identity(playlist) || loaded.keyVisualPath !== keyVisualPath) {
      throw new Error(t('Проверка файла проекта не прошла'))
    }
    // Existing backups are never overwritten by a partial new transfer.
    let final = join(opts.parent, opts.name)
    for (let n = 2; ; n++) {
      try { await access(final); final = join(opts.parent, `${opts.name} (${n})`) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        break
      }
    }
    await rename(stage, final)
    published = true
    const path = join(final, projectFile)
    opts.progress({ phase: 'done', completed: check.length, total: check.length, file: '', path })
    return { path, copied: copies.size }
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true })
  }
}
