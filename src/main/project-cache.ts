import { app } from 'electron'
import { existsSync, readdirSync, lstatSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { t } from '../shared/i18n.js'
import type { TransferFile } from './project-transfer.js'

export const PPTX_MANIFEST_VERSION = 7
export const PROJECT_CACHE_FOLDER = 'pptx-cache'
const projectRoots = new Map<string, string>()
const discoveredPdfPaths = new Map<string, string>()

export function localPptxCacheDir(): string {
  return join(app.getPath('userData'), 'pptx-cache')
}

/** Read all cache layouts: legacy, short-lived hash folder, and name/sha.pdf. */
export function pdfCachePath(root: string, sha1: string): string | null {
  const key = `${root}\0${sha1}`
  const known = discoveredPdfPaths.get(key)
  if (known) {
    try {
      if (lstatSync(known).isFile()) return known
    } catch { /* This PDF was rebuilt or cleared. */ }
    discoveredPdfPaths.delete(key)
  }
  const legacy = join(root, `${sha1}.pdf`)
  try {
    if (lstatSync(legacy).isFile()) {
      discoveredPdfPaths.set(key, legacy)
      return legacy
    }
  } catch { /* No legacy PDF. */ }
  const folder = join(root, sha1)
  try {
    if (lstatSync(folder).isDirectory()) {
      const pdfs = readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.pdf') &&
        lstatSync(join(folder, name)).isFile())
      if (pdfs.length === 1) {
        const path = join(folder, pdfs[0])
        discoveredPdfPaths.set(key, path)
        return path
      }
    }
  } catch {
    // No cache under the legacy hash folder.
  }
  try {
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name)
      if (!lstatSync(dir).isDirectory()) continue
      const pdf = join(dir, `${sha1}.pdf`)
      try {
        if (lstatSync(pdf).isFile()) {
          discoveredPdfPaths.set(key, pdf)
          return pdf
        }
      } catch { /* This name has no PDF for this hash. */ }
    }
  } catch {
    // Cache directory does not exist yet.
  }
  return null
}

/** Keep the binding for decks already on air when another project is opened. */
export function pptxReadCacheDir(sha1: string): string {
  const root = projectRoots.get(sha1)
  return root && pdfCachePath(root, sha1) ? root : localPptxCacheDir()
}

export function forgetProjectCache(sha1: string): void {
  projectRoots.delete(sha1)
}

type LocalCacheItem = { path: string; sha1: string; directory: boolean }
export type LocalCacheStats = { bytes: number; files: number; protectedBytes: number }
const SHA1 = /^[a-f0-9]{40}$/

/** Only paths created by CueDeck are candidates; unknown files are left alone. */
async function localCacheItems(): Promise<LocalCacheItem[]> {
  const root = localPptxCacheDir()
  try {
    if (!(await lstat(root)).isDirectory()) return []
  } catch { return [] }
  const items: LocalCacheItem[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const file = /^([a-f0-9]{40})\.(?:pdf|media\.json|rebuilt\.pptx)$/.exec(entry.name)
    const media = /^([a-f0-9]{40})\.media$/.exec(entry.name)
    const tmp = /^tmp-([a-f0-9]{40})-\d+$/.exec(entry.name)
    if (entry.isFile() && file) items.push({ path, sha1: file[1], directory: false })
    else if (entry.isDirectory() && (media || tmp)) {
      items.push({ path, sha1: (media || tmp)![1], directory: true })
    } else if (entry.isDirectory()) {
      for (const nested of await readdir(path, { withFileTypes: true })) {
        const name = entry.name
        const oldHashFolder = SHA1.test(name) && nested.name.toLowerCase().endsWith('.pdf')
        const namedFolder = SHA1.test(nested.name.slice(0, -4)) && nested.name.endsWith('.pdf')
        if (nested.isFile() && (oldHashFolder || namedFolder)) {
          items.push({ path: join(path, nested.name), sha1: oldHashFolder ? name : nested.name.slice(0, -4), directory: false })
        }
      }
    }
  }
  return items
}

async function cacheBytes(path: string): Promise<number> {
  const info = await lstat(path)
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let bytes = 0
  for (const name of await readdir(path)) bytes += await cacheBytes(join(path, name))
  return bytes
}

export async function localCacheStats(protectedHashes: ReadonlySet<string> = new Set()): Promise<LocalCacheStats> {
  const items = await localCacheItems()
  let bytes = 0
  let protectedBytes = 0
  for (const item of items) {
    const size = await cacheBytes(item.path)
    bytes += size
    if (protectedHashes.has(item.sha1)) protectedBytes += size
  }
  return { bytes, files: items.length, protectedBytes }
}

export async function clearLocalCache(protectedHashes: ReadonlySet<string>): Promise<LocalCacheStats> {
  const items = await localCacheItems()
  let bytes = 0
  let files = 0
  let protectedBytes = 0
  for (const item of items) {
    const size = await cacheBytes(item.path)
    if (protectedHashes.has(item.sha1)) { protectedBytes += size; continue }
    const info = await lstat(item.path)
    if (item.directory ? !info.isDirectory() : !info.isFile()) continue
    await rm(item.path, { recursive: item.directory })
    bytes += size
    files++
  }
  // Remove only empty folders; a live PDF or an unknown user file keeps its folder.
  const folders = await readdir(localPptxCacheDir(), { withFileTypes: true }).catch(() => [])
  for (const entry of folders) {
    if (entry.isDirectory()) await rmdir(join(localPptxCacheDir(), entry.name)).catch(() => undefined)
  }
  return { bytes, files, protectedBytes }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/** Validate the whole deck before adopting it, including every referenced video. */
async function cacheMedia(root: string, sha1: string, needsManifest: boolean): Promise<string[] | null> {
  if (!pdfCachePath(root, sha1)) return null
  if (!needsManifest) return []
  try {
    const manifestPath = join(root, `${sha1}.media.json`)
    if (!(await regularFile(manifestPath))) return null
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.version !== PPTX_MANIFEST_VERSION || typeof manifest.rebuilt !== 'boolean' ||
        !Array.isArray(manifest.slideMedia) || !Array.isArray(manifest.fonts) ||
        !manifest.fonts.every((font: unknown) => typeof font === 'string') ||
        !manifest.pageNotes || typeof manifest.pageNotes !== 'object' || Array.isArray(manifest.pageNotes) ||
        !Object.values(manifest.pageNotes).every((note) => typeof note === 'string')) return null
    const files = new Set<string>()
    if (manifest.slideMedia.length && !(await lstat(join(root, `${sha1}.media`))).isDirectory()) return null
    for (const media of manifest.slideMedia) {
      if (!media || typeof media.file !== 'string' || !media.file ||
          /[/\\\0]/.test(media.file) || media.file === '.' || media.file === '..' ||
          !Number.isInteger(media.slide) || media.slide < 1 ||
          !media.rect || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite(media.rect[key]))) return null
      if ((media.autoPlay !== undefined && typeof media.autoPlay !== 'boolean') ||
          (media.loop !== undefined && typeof media.loop !== 'boolean')) return null
      if (media.crop !== undefined && (!media.crop || typeof media.crop !== 'object' ||
          !['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(media.crop[key])) ||
          media.crop.left + media.crop.right >= 1 || media.crop.top + media.crop.bottom >= 1)) return null
      if (!(await regularFile(join(root, `${sha1}.media`, media.file)))) return null
      files.add(media.file)
    }
    return [...files]
  } catch {
    return null
  }
}

/** The source SHA1 was computed from the original: changed decks cannot use stale PDFs. */
export async function useProjectCache(sha1: string, filePath: string, projectPath: string | null): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/.test(sha1)) return false
  if (pdfCachePath(localPptxCacheDir(), sha1)) {
    forgetProjectCache(sha1)
    return false
  }
  if (!projectPath) return false
  const rel = relative(dirname(projectPath), filePath)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  const root = join(dirname(projectPath), PROJECT_CACHE_FOLDER)
  const media = await cacheMedia(root, sha1, /\.pptx$/i.test(filePath))
  if (media === null) return false
  projectRoots.set(sha1, root)
  return true
}

/** Copy only this deck's finished artifacts; PDF is committed after its dependencies. */
export async function exportProjectCache(sha1: string, filePath: string, projectDir: string): Promise<TransferFile[]> {
  const source = pptxReadCacheDir(sha1)
  const needsManifest = /\.pptx$/i.test(filePath)
  const files = await cacheMedia(source, sha1, needsManifest)
  if (files === null) throw new Error(t('Кэш презентации не готов: {path}', { path: filePath }))
  const target = join(projectDir, PROJECT_CACHE_FOLDER)
  const pdf = pdfCachePath(source, sha1)!
  const pdfRel = relative(source, pdf)
  const artifacts = [pdfRel, ...(needsManifest ? [`${sha1}.media.json`, ...files.map((file) => join(`${sha1}.media`, file))] : [])]
  const transferred = artifacts.map((file) => ({ source: join(source, file), target: join(target, file) }))
  if (resolve(source) === resolve(target)) return transferred
  await mkdir(target, { recursive: true })
  const stage = await mkdtemp(join(target, '.cache-'))
  try {
    await mkdir(dirname(join(stage, pdfRel)), { recursive: true })
    await copyFile(pdf, join(stage, pdfRel))
    if (needsManifest) {
      await copyFile(join(source, `${sha1}.media.json`), join(stage, `${sha1}.media.json`))
      if (files.length) {
        await mkdir(join(stage, `${sha1}.media`))
        for (const file of files) await copyFile(join(source, `${sha1}.media`, file), join(stage, `${sha1}.media`, file))
        await mkdir(join(target, `${sha1}.media`), { recursive: true })
        for (const file of files) await rename(join(stage, `${sha1}.media`, file), join(target, `${sha1}.media`, file))
      }
      await rename(join(stage, `${sha1}.media.json`), join(target, `${sha1}.media.json`))
    }
    await mkdir(dirname(join(target, pdfRel)), { recursive: true })
    await rename(join(stage, pdfRel), join(target, pdfRel))
    // A renamed source with the same bytes must leave one PDF for this hash.
    if (pdfRel !== `${sha1}.pdf` && await regularFile(join(target, `${sha1}.pdf`))) {
      await rm(join(target, `${sha1}.pdf`))
    }
    for (const name of readdirSync(target)) {
      const folder = join(target, name)
      if (!(await lstat(folder)).isDirectory()) continue
      if (name === sha1) {
        for (const file of readdirSync(folder)) {
          const old = join(folder, file)
          if (old !== join(target, pdfRel) && file.toLowerCase().endsWith('.pdf') && await regularFile(old)) {
            await rm(old)
          }
        }
      } else {
        const old = join(folder, `${sha1}.pdf`)
        if (old !== join(target, pdfRel) && await regularFile(old)) await rm(old)
      }
      await rmdir(folder).catch(() => undefined)
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  return transferred
}
