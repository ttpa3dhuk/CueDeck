import { dialog, type BrowserWindow } from 'electron'
import { t } from '../shared/i18n.js'

/** Only manual closes ask; layout reconciliation and app shutdown bypass this. */
export function attachAudienceCloseGuard(
  win: BrowserWindow,
  shouldAsk: () => boolean,
): void {
  let asking = false
  let confirmed = false
  win.on('close', event => {
    if (confirmed || !shouldAsk()) return
    event.preventDefault()
    if (asking) return
    asking = true
    const options = {
      type: 'question' as const,
      title: t('Закрыть окно зала?'),
      message: t('Закрыть окно зала?'),
      detail: t('Чтобы открыть окно снова, выбери нужный режим в меню «Экраны → Режим работы».'),
      buttons: [t('Отмена'), t('Закрыть окно')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    // A sheet on the window being closed preserves its position and stacking.
    const result = dialog.showMessageBox(win, options)
    void result.then(({ response }) => {
      if (response !== 1 || win.isDestroyed() || !shouldAsk()) return
      confirmed = true
      win.close()
    }).catch(() => undefined).finally(() => { asking = false })
  })
}
