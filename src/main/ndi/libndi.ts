/**
 * Привязка к библиотеке NDI (Vizrt NDI SDK, ndi.video). Через koffi (FFI):
 * никакой компиляции под каждую версию Electron, рантайм NDI кладётся готовым
 * в vendor/ndi (win/mac) и пакуется в ресурсы приложения.
 *
 * Грузится лениво — при первом включённом выходе. Не загрузилась (нет файла,
 * старая система) — выходы NDI недоступны, остальная программа работает.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { t } from '../../shared/i18n.js'
import { createNdiLibrary, ndiFileName, type NdiLib } from './libndi-native.js'
export * from './libndi-native.js'

let lib: NdiLib | null = null
let loadError: string | null = null

/** Папка с рантаймом NDI: в сборке — ресурсы приложения, в разработке — vendor/ репозитория. */
export function libDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'ndi')
  return join(app.getAppPath(), 'vendor', 'ndi', process.platform === 'win32' ? 'win' : 'mac')
}

/** Загрузить NDI; null — недоступно, причина в ndiLoadError(). */
export function loadNdi(): NdiLib | null {
  if (lib || loadError) return lib
  try {
    if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error(t('NDI в CueDeck есть только на macOS и Windows'))
    const directory = libDir()
    const path = join(directory, ndiFileName())
    if (!existsSync(path)) throw new Error(t('нет файла {path}', { path }))
    const created = createNdiLibrary(directory)
    if (!created.initialize()) throw new Error(t('NDIlib_initialize не сработала'))
    lib = created
    log.info(`ndi: библиотека NDI загружена (${directory}), версия ${created.version()}`)
  } catch (err) {
    loadError = (err as Error).message || String(err)
    log.warn(`ndi: библиотека NDI не загрузилась — ${loadError}`)
  }
  return lib
}

export function ndiLoadError(): string | null {
  return loadError
}
