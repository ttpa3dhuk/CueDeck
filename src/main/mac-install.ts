import { app, dialog } from 'electron'
import { t } from '../shared/i18n.js'

let moving = false

/** Native relocation quits and relaunches; the ordinary quit guard must not intercept it. */
export function isMovingToApplications(): boolean {
  return moving
}

/** Returns true when startup must stop because the installed copy will take over. */
export async function offerMacInstall(): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return false

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'CueDeck',
    message: t('Перенести CueDeck в Программы?'),
    detail: t('CueDeck будет в папке «Программы», чтобы его было проще найти. Если CueDeck уже установлен, эта копия заменит его. Настройки и проекты сохранятся. После переноса приложение запустится оттуда.'),
    buttons: [t('Перенести в Программы'), t('Запустить здесь')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) return false

  while (true) {
    let runningConflict = false
    try {
      moving = true
      const moved = app.moveToApplicationsFolder({
        conflictHandler: (conflictType) => {
          if (conflictType === 'existsAndRunning') {
            runningConflict = true
            return false
          }
          return true
        },
      })
      if (moved) return true
      moving = false
      if (runningConflict) {
        const retry = await dialog.showMessageBox({
          type: 'info',
          title: 'CueDeck',
          message: t('CueDeck в Программах уже работает'),
          detail: t('Закройте установленный CueDeck, затем нажмите «Перенести в Программы». Это окно можно оставить открытым.'),
          buttons: [t('Перенести в Программы'), t('Отмена')],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        if (retry.response === 0) continue
        app.quit()
        return true
      }
    } catch (error) {
      moving = false
      console.error('CueDeck relocation failed:', error)
      await dialog.showMessageBox({
        type: 'error',
        title: 'CueDeck',
        message: t('Не удалось перенести CueDeck'),
        detail: t('Можно перенести CueDeck.app в папку «Программы» через Finder. Сейчас приложение запустится из текущей папки.'),
        buttons: [t('Понятно')],
      })
    }
    return false
  }
}
