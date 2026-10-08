import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

/**
 * Шрифты, которые принесли вместе с презентацией. LibreOffice берёт шрифты
 * только у системы (свои папки на маке он не читает — проверено), поэтому
 * копируем их в пользовательскую папку шрифтов: права администратора не нужны,
 * система не трогается. Что скопировали — запоминаем в файле-списке, чтобы
 * потом убрать ровно это и ничего больше.
 *
 * Без Electron: папки и файл-список передаются снаружи — покрыто tests/user-fonts.test.ts.
 * Регистрация в системе (на Windows мало положить файл) — через `hooks`.
 */

export interface FontHooks {
  /** После копирования: зарегистрировать шрифт в системе. */
  install?: (path: string) => Promise<void>
  /** Перед удалением файла: снять регистрацию. */
  uninstall?: (path: string) => Promise<void>
}

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc', '.otc'])
const MAX_DEPTH = 4

/** Файлы шрифтов из выбранных файлов и папок (папки — вглубь, скрытое и ссылки пропускаем). */
export async function collectFontFiles(paths: string[], depth = 0): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    const name = basename(p)
    // `._Name.ttf` — служебные копии macOS, не шрифты.
    if (name.startsWith('.')) continue
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      // Не папка: файл шрифта или то, что читать нельзя.
      if (FONT_EXTS.has(extname(p).toLowerCase())) out.push(p)
      continue
    }
    if (depth >= MAX_DEPTH) continue
    const inner = entries.filter((e) => !e.isSymbolicLink()).map((e) => join(p, e.name))
    out.push(...(await collectFontFiles(inner, depth + 1)))
  }
  return out
}

export interface AddFontsResult {
  /** Скопированные файлы (полные пути в папке шрифтов). */
  added: string[]
  /** Имена файлов, которые уже лежат в папке: чужое не перезаписываем. */
  skipped: string[]
  /** Скопированы, но система их не приняла (битый файл и т. п.). */
  failed: string[]
}

async function readList(listFile: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(listFile, 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Скопировать шрифты в `destDir` и дописать их в список. Существующие файлы не трогаем. */
export async function addFonts(
  sources: string[],
  destDir: string,
  listFile: string,
  hooks: FontHooks = {},
): Promise<AddFontsResult> {
  const files = await collectFontFiles(sources)
  const added: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  if (files.length === 0) return { added, skipped, failed }

  await mkdir(destDir, { recursive: true })
  for (const src of files) {
    const dest = join(destDir, basename(src))
    if (existsSync(dest)) {
      skipped.push(basename(src))
      continue
    }
    await copyFile(src, dest)
    // В список — сразу после копии: даже непринятый файл «Убрать» должно стереть.
    added.push(dest)
    try {
      await hooks.install?.(dest)
    } catch {
      failed.push(basename(src))
    }
  }
  if (added.length > 0) {
    const list = await readList(listFile)
    await writeFile(listFile, JSON.stringify([...new Set([...list, ...added])], null, 2))
  }
  return { added, skipped, failed }
}

/** Сколько добавленных нами шрифтов ещё лежит в папке. */
export async function addedFontsCount(listFile: string): Promise<number> {
  return (await readList(listFile)).filter((p) => existsSync(p)).length
}

/**
 * Убрать добавленные нами шрифты. Удаляем только пути из списка и только если
 * они лежат внутри `destDir`: испорченный список не должен стереть чужое.
 */
export async function removeAddedFonts(destDir: string, listFile: string, hooks: FontHooks = {}): Promise<number> {
  const root = resolve(destDir) + sep
  let removed = 0
  const left: string[] = []
  for (const p of await readList(listFile)) {
    if (!resolve(p).startsWith(root)) continue
    if (!existsSync(p)) continue
    try {
      await hooks.uninstall?.(p)
      await rm(p)
      removed += 1
    } catch {
      left.push(p)
    }
  }
  await writeFile(listFile, JSON.stringify(left, null, 2))
  return removed
}
