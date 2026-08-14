import { spawn } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import { app } from 'electron'

/**
 * Где искать LibreOffice. Пути платформозависимы — на Windows их не было
 * вовсе, из-за чего установленный LibreOffice не находился никогда и
 * приложение продолжало просить его поставить (баг, найден Азатом 2026-08-02).
 *
 * На Windows первым идёт `soffice.com`, а не `.exe`: `.exe` — GUI-лаунчер,
 * он отдаёт управление сразу, и мы прочитали бы выходную папку раньше, чем
 * конвертация закончится. `.com` — консольный вариант, он дожидается конца.
 */
function sofficeCandidates(): string[] {
  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['ProgramW6432'],
      // Установка «только для меня» не пишет в Program Files.
      process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs') : undefined,
    ].filter((r): r is string => Boolean(r))
    const out: string[] = []
    for (const root of roots) {
      for (const exe of ['soffice.com', 'soffice.exe']) {
        out.push(join(root, 'LibreOffice', 'program', exe))
      }
    }
    return out
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
    ]
  }
  return ['/usr/bin/soffice', '/usr/bin/libreoffice', '/snap/bin/libreoffice']
}

let cachedSofficePath: string | null | undefined = undefined

/** Поиск по PATH. На Windows это `where`, `which` там отсутствует. */
function whichSoffice(): Promise<string | null> {
  const win = process.platform === 'win32'
  return new Promise((resolve) => {
    const proc = spawn(win ? 'where' : 'which', ['soffice'], { shell: win })
    let out = ''
    proc.stdout.on('data', (d) => (out += String(d)))
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      // `where` может вернуть несколько строк — берём первую.
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      if (code === 0 && first) resolve(first)
      else resolve(null)
    })
  })
}

export async function findSoffice(): Promise<string | null> {
  if (cachedSofficePath !== undefined) return cachedSofficePath
  for (const candidate of sofficeCandidates()) {
    if (existsSync(candidate)) {
      cachedSofficePath = candidate
      return candidate
    }
  }
  const fromPath = await whichSoffice()
  cachedSofficePath = fromPath
  return fromPath
}

/**
 * Сбросить кэш и поискать заново — для кнопки «Проверить снова» после
 * установки. Без этого результат живёт до перезапуска приложения.
 */
export async function recheckSoffice(): Promise<string | null> {
  cachedSofficePath = undefined
  return findSoffice()
}

/** Куда мы смотрели — показываем в подсказке, если так и не нашли. */
export function sofficeSearchPaths(): string[] {
  return sofficeCandidates()
}

function cacheDir(): string {
  return join(app.getPath('userData'), 'pptx-cache')
}

export function cachedPdfPathFor(sha1: string): string {
  return join(cacheDir(), `${sha1}.pdf`)
}

export function cachedPdfExists(sha1: string): boolean {
  return existsSync(cachedPdfPathFor(sha1))
}

export async function convertPptxToPdf(pptxPath: string, sourceSha1: string): Promise<string> {
  const target = cachedPdfPathFor(sourceSha1)
  if (existsSync(target)) return target

  const soffice = await findSoffice()
  if (!soffice) {
    throw new Error('LibreOffice не установлен — скачай с libreoffice.org и перезапусти CueDeck')
  }

  await mkdir(cacheDir(), { recursive: true })
  const tmpDir = join(cacheDir(), `tmp-${sourceSha1}-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(soffice, [
        '--headless',
        '--norestore',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        tmpDir,
        pptxPath,
      ])
      let stderr = ''
      proc.stderr.on('data', (d) => (stderr += String(d)))
      proc.on('error', (err) => reject(err))
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`LibreOffice exit ${code}: ${stderr.trim() || 'unknown error'}`))
      })
    })

    const parsed = parse(pptxPath)
    const generated = join(tmpDir, `${parsed.name}.pdf`)
    if (!existsSync(generated)) {
      throw new Error('LibreOffice не создал PDF (возможно, файл повреждён)')
    }
    await rename(generated, target)
    return target
  } finally {
    rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
