import { app } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { t } from '../shared/i18n.js'
import type { TransferFile } from './project-transfer.js'

export const PPTX_MANIFEST_VERSION = 5
export const PROJECT_CACHE_FOLDER = 'pptx-cache'
const projectRoots = new Map<string, string>()

export function localPptxCacheDir(): string {
  return join(app.getPath('userData'), 'pptx-cache')
}

/** Keep the binding for decks already on air when another project is opened. */
export function pptxReadCacheDir(sha1: string): string {
  const root = projectRoots.get(sha1)
  return root && existsSync(join(root, `${sha1}.pdf`)) ? root : localPptxCacheDir()
}

export function forgetProjectCache(sha1: string): void {
  projectRoots.delete(sha1)
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
  if (!(await regularFile(join(root, `${sha1}.pdf`)))) return null
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
  if (existsSync(join(localPptxCacheDir(), `${sha1}.pdf`))) {
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
  const artifacts = [`${sha1}.pdf`, ...(needsManifest ? [`${sha1}.media.json`, ...files.map((file) => join(`${sha1}.media`, file))] : [])]
  const transferred = artifacts.map((file) => ({ source: join(source, file), target: join(target, file) }))
  if (resolve(source) === resolve(target)) return transferred
  await mkdir(target, { recursive: true })
  const stage = await mkdtemp(join(target, '.cache-'))
  try {
    await copyFile(join(source, `${sha1}.pdf`), join(stage, `${sha1}.pdf`))
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
    await rename(join(stage, `${sha1}.pdf`), join(target, `${sha1}.pdf`))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  return transferred
}
