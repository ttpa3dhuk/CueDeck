import { t } from './i18n.js'

/** Worker diagnostics stay in the log; cards show a stable localized action. */
export function preparationErrorMessage(code: string): string {
  switch (code) {
    case 'libreoffice_missing': return t('LibreOffice не установлен — скачай с libreoffice.org и перезапусти CueDeck')
    case 'cancelled':
    case 'superseded': return t('Подготовка отменена')
    case 'source_changed': return t('Файл изменился во время подготовки. Повтори подготовку.')
    case 'timeout': return t('Подготовка заняла слишком много времени. Попробуй повторить.')
    case 'worker_crash': return t('Процесс подготовки завершился. Попробуй повторить.')
    case 'invalid_archive':
    case 'invalid_cache': return t('Не удалось подготовить презентацию: проверь исходный файл и повтори.')
    default: return t('Не удалось прочитать или сконвертировать файл. Проверь файл и доступность диска.')
  }
}
