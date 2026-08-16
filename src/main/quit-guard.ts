import { app, BrowserWindow, dialog, globalShortcut } from 'electron'
import { flushPendingWrites, saveProject } from './ipc.js'

/**
 * Подтверждение при закрытии (PLAN «🛡 ОТКРЫТО: подтверждение при закрытии»).
 * Случайный крестик или Cmd+Q посреди эфира гасил зал молча — теперь спрашиваем.
 *
 * Ключевые правила (нарушишь — станет хуже, чем было):
 * - Перехватываем закрытие ТОЛЬКО у окна оператора. Окна зала и суфлёра
 *   штатно пересоздаются при каждой смене раскладки (`applyLayout`), и общий
 *   обработчик спрашивал бы подтверждение на каждом переключении экранов.
 * - Ловим и `before-quit` (Cmd+Q, Alt+F4, меню), а не только крестик: во время
 *   шоу опаснее как раз горячая клавиша.
 * - Диалог — сheet на окне оператора, поэтому физически не может вылезти на
 *   зал или суфлёр (правило 5).
 * - Отмена в «Сохранить как» не закрывает приложение.
 */

let confirmed = false
let asking = false
let operatorWin: BrowserWindow | null = null

/** Вешается на окно оператора при каждом его создании (см. windows.ts). */
export function attachOperatorCloseGuard(win: BrowserWindow): void {
  operatorWin = win
  win.on('close', (e) => {
    if (confirmed) return
    e.preventDefault()
    void requestQuit()
  })
  win.on('closed', () => {
    if (operatorWin === win) operatorWin = null
  })
}

/**
 * Единая точка выхода: спрашивает (один раз), дописывает файлы и выходит.
 * `app.exit(0)` не поднимает before-quit заново, поэтому рекурсии нет.
 */
export async function requestQuit(): Promise<void> {
  if (asking) {
    // Диалог уже висит — не плодим второй, просто показываем его.
    if (operatorWin && !operatorWin.isDestroyed()) operatorWin.focus()
    return
  }
  if (!confirmed) {
    const op = operatorWin && !operatorWin.isDestroyed() ? operatorWin : null
    // Окна оператора ещё/уже нет (выход во время стартовых диалогов) —
    // терять нечего, спрашивать не о чем.
    if (op) {
      asking = true
      let ok = false
      try {
        ok = await confirmClose(op)
      } finally {
        asking = false
      }
      if (!ok) return
    }
    confirmed = true
  }
  globalShortcut.unregisterAll()
  await flushPendingWrites()
  app.exit(0)
}

async function confirmClose(op: BrowserWindow): Promise<boolean> {
  const { response } = await dialog.showMessageBox(op, {
    type: 'warning',
    buttons: ['Сохранить и закрыть', 'Закрыть без сохранения', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: 'Закрыть CueDeck?',
    detail: 'Экраны зала и суфлёра погаснут.',
  })
  if (response === 2) return false
  if (response === 1) return true

  const res = await saveProject(false)
  if (res.ok) return true
  // Ошибка записи — сказать вслух и остаться в приложении: молча закрыться,
  // потеряв проект, хуже всего.
  if (res.error) {
    await dialog.showMessageBox(op, {
      type: 'error',
      buttons: ['Понятно'],
      message: 'Не удалось сохранить проект',
      detail: res.error,
    })
  }
  // Отмена в «Сохранить как» — тоже остаёмся.
  return false
}
