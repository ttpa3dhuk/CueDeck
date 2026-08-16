import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

/**
 * Файловые операции над материалами проекта: поиск переехавших (relink) и
 * сборка проекта в одну папку (consolidate). Вынесено из ipc.ts, чтобы это
 * можно было гонять тестами без Electron.
 */

/** Глубина и потолок файлов: пользователь может ткнуть в корень диска. */
const MAX_DEPTH = 6
const MAX_FILES = 50_000

/**
 * Индекс папки: имя файла в нижнем регистре → все найденные пути.
 * Регистр гасим намеренно: файл, приехавший с Windows, легко меняет его.
 * Скрытые папки пропускаем — в `.git`/`node_modules` материалов не бывает,
 * а время сканирования они съедают.
 */
export async function indexFolder(
  root: string,
  opts: { maxDepth?: number; maxFiles?: number } = {},
): Promise<Map<string, string[]>> {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const maxFiles = opts.maxFiles ?? MAX_FILES
  const index = new Map<string, string[]>()
  let seen = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || seen >= maxFiles) return
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return // нет прав / исчезла — молча пропускаем
    }
    for (const item of items) {
      if (seen >= maxFiles) return
      if (item.name.startsWith('.')) continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(full, depth + 1)
      } else if (item.isFile()) {
        seen += 1
        const key = item.name.toLowerCase()
        const list = index.get(key)
        if (list) list.push(full)
        else index.set(key, [full])
      }
    }
  }

  await walk(root, 0)
  return index
}

/**
 * Выбор кандидата, когда одинаковых имён в папке несколько: берём самый
 * «мелкий» по вложенности — материал обычно лежит в корне сборки, а копии
 * расползаются по подпапкам (архивы, backup и т.п.).
 */
export function pickBestCandidate(paths: string[]): string {
  return [...paths].sort(
    (a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b),
  )[0]
}

/**
 * Свободное имя внутри целевой папки: два разных файла могут называться
 * одинаково (`презентация.pdf` у двух спикеров) — второй станет
 * `презентация-2.pdf`. `taken` — уже занятые имена в нижнем регистре.
 */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase())
    return name
  }
  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}${ext}`
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase())
      return candidate
    }
  }
}
