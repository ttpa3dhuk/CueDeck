import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'

/**
 * Установка шрифта «для текущего пользователя» на Windows без прав
 * администратора — так же, как делает «Установить» в контекстном меню:
 * файл в %LOCALAPPDATA%\Microsoft\Windows\Fonts (копирует user-fonts.ts),
 * запись в HKCU\…\Fonts (шрифт переживёт перезагрузку) и AddFontResourceW
 * (шрифт виден сразу, без выхода из учётки — LibreOffice берёт шрифты сеанса).
 */

const run = promisify(execFile)
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const WM_FONTCHANGE = 0x001d
const HWND_BROADCAST = 0xffff

interface Gdi {
  add: (path: string) => number
  remove: (path: string) => number
  notify: () => void
}
let gdi: Gdi | null = null

function loadGdi(): Gdi {
  if (gdi) return gdi
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  const g = koffi.load('gdi32.dll')
  const u = koffi.load('user32.dll')
  const add = g.func('int __stdcall AddFontResourceW(str16 name)')
  const remove = g.func('int __stdcall RemoveFontResourceW(str16 name)')
  // PostMessage, не SendMessage: зависшее чужое окно не должно держать CueDeck.
  const post = u.func('int __stdcall PostMessageW(intptr_t hwnd, uint32 msg, uintptr_t wparam, intptr_t lparam)')
  gdi = {
    add: (p) => add(p) as number,
    remove: (p) => remove(p) as number,
    notify: () => void post(HWND_BROADCAST, WM_FONTCHANGE, 0, 0),
  }
  return gdi
}

/** Имя значения в реестре: своё, с пометкой, чтобы не путать с установленным руками. */
function valueName(path: string): string {
  return `${basename(path, extname(path))} (CueDeck)`
}

export async function installWinFont(path: string): Promise<void> {
  await run('reg', ['add', REG_KEY, '/v', valueName(path), '/t', 'REG_SZ', '/d', path, '/f'], { windowsHide: true })
  const g = loadGdi()
  if (g.add(path) === 0) throw new Error(`AddFontResourceW: ${basename(path)}`)
  g.notify()
}

export async function uninstallWinFont(path: string): Promise<void> {
  const g = loadGdi()
  // Сначала выгрузить из сеанса: загруженный файл Windows удалить не даст.
  g.remove(path)
  g.notify()
  await run('reg', ['delete', REG_KEY, '/v', valueName(path), '/f'], { windowsHide: true }).catch(() => undefined)
}
