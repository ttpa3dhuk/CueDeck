/**
 * Привязка к libomt — библиотеке Open Media Transport (MIT, github.com/openmediatransport).
 * Через koffi (FFI): никакой компиляции под каждую версию Electron, бинарник
 * libomt берётся готовый из официального релиза (scripts/fetch-omt.cjs).
 *
 * Грузится лениво — при первом включённом выходе. Не загрузилась (старая
 * macOS, нет файла) — выходы OMT недоступны, остальная программа работает.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { logsDir } from '../diag.js'
import { t } from '../../shared/i18n.js'
import { createOmtLibrary, type OmtLib } from './libomt-native.js'
export * from './libomt-native.js'

let lib: OmtLib | null = null
let loadError: string | null = null

/** Папка с libomt: в сборке — ресурсы приложения, в разработке — vendor/ репозитория. */
export function libDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'omt')
  return join(app.getAppPath(), 'vendor', 'omt', process.platform === 'win32' ? 'win' : 'mac')
}

/** Загрузить libomt; null — недоступно, причина в omtLoadError(). */
export function loadOmt(): OmtLib | null {
  if (lib || loadError) return lib
  try {
    if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error(t('OMT в CueDeck есть только на macOS и Windows'))
    const directory = libDir()
    for (const base of ['libomt', 'libvmx']) {
      const path = join(directory, `${base}.${process.platform === 'win32' ? 'dll' : 'dylib'}`)
      if (!existsSync(path)) throw new Error(t('нет файла {path}', { path }))
    }
    lib = createOmtLibrary(directory, join(logsDir(), 'omt.log'))
    log.info(`omt: libomt загружена (${directory})`)
  } catch (err) {
    loadError = (err as Error).message || String(err)
    log.warn(`omt: libomt не загрузилась — ${loadError}`)
  }
  return lib
}

export function omtLoadError(): string | null {
  return loadError
}
