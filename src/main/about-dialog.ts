import { app, dialog, shell } from 'electron'
import { t } from '../shared/i18n.js'
import { getOperatorWindow } from './windows.js'

const GITHUB_URL = 'https://github.com/ttpa3dhuk/CueDeck'
const DOWNLOAD_URL = `${GITHUB_URL}/releases/latest`
let opened = false

/** Одинаковые сведения и ссылки на Mac и Windows, без версии Electron. */
export async function showAboutDialog(): Promise<void> {
  if (opened) return
  opened = true
  try {
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: t('О CueDeck'),
      message: 'CueDeck',
      detail: `${t('Версия {version}', { version: app.getVersion() })}\n© 2026 Azat Khusaenov\nMIT\n\n${GITHUB_URL}`,
      buttons: ['GitHub', t('Скачать CueDeck'), t('Закрыть')],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    }
    const op = getOperatorWindow()
    const { response } = op && !op.isDestroyed()
      ? await dialog.showMessageBox(op, options)
      : await dialog.showMessageBox(options)
    if (response === 0) await shell.openExternal(GITHUB_URL)
    else if (response === 1) await shell.openExternal(DOWNLOAD_URL)
  } catch (error) {
    console.warn('[about]', error)
  } finally {
    opened = false
  }
}
