import { BrowserWindow } from 'electron'
import type { Lang } from '../shared/i18n.js'

/**
 * Первый запуск: «на каком языке работаем?» (Азат 2026-09-25). Предложен
 * английский (DEFAULT_LANG) — у всех, включая старые установки. Показывается,
 * пока язык не выбран ни разу, — самым первым окном, раньше плашки и выбора
 * раскладки: они уже рисуются на выбранном языке. Потом язык меняется в
 * «Настройки → Интерфейс».
 *
 * Техника та же, что у boot-dialog.ts: frameless-окно со страницей в
 * data:-URL, ответ в main через document.title. Текст двуязычный — язык ещё
 * не знаем. Enter — предложенный язык, 1/2 — English/Русский.
 */

export interface LangChoice {
  lang: Lang
  /** false — окно закрыли без выбора: язык взят предложенный, в следующий раз спросим снова. */
  chosen: boolean
}

function pageHtml(suggested: Lang): string {
  const btn = (l: Lang, label: string, key: string): string =>
    `<button data-l="${l}"${l === suggested ? ' class="suggested"' : ''}>${label}<span>${key}</span></button>`
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>CueDeck</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-app-region: drag; user-select: none;
  }
  .wrap {
    background: #181b22; color: #e6e8ec; border: 1px solid #2a2f3a;
    border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 8px;
  }
  h1 { font-size: 15px; font-weight: 600; }
  .sub { font-size: 12px; color: #8b93a3; margin-bottom: 6px; }
  button {
    -webkit-app-region: no-drag; width: 100%; padding: 10px 12px; font-size: 14px;
    background: #1f232c; color: #e6e8ec; border: 1px solid #2a2f3a;
    border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between;
  }
  button span { color: #6b7280; font-size: 12px; }
  button:hover { background: #2a2f3a; }
  button.suggested { border-color: #4c8bf5; background: #24314b; }
  button.suggested:hover { background: #2c3b5a; }
</style></head><body><div class="wrap">
  <h1>Interface language · Язык интерфейса</h1>
  <div class="sub">You can change it later: ⚙ Settings → Interface.<br>Можно сменить потом: ⚙ Настройки → Интерфейс.</div>
  ${btn('en', 'English', '1')}
  ${btn('ru', 'Русский', '2')}
</div><script>
  var pick = function (l) { document.title = 'cd:' + l }
  document.querySelectorAll('button[data-l]').forEach(function (b) {
    b.addEventListener('click', function () { pick(b.dataset.l) })
  })
  addEventListener('keydown', function (e) {
    if (e.key === 'Enter') pick('${suggested}')
    else if (e.key === '1') pick('en')
    else if (e.key === '2') pick('ru')
  })
</script></body></html>`
}

export function askUiLang(suggested: Lang): Promise<LangChoice> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 380,
      height: 220,
      useContentSize: true,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      center: true,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    let settled = false
    const settle = (choice: LangChoice): void => {
      if (settled) return
      settled = true
      resolve(choice)
      if (!win.isDestroyed()) win.close()
    }
    win.webContents.on('page-title-updated', (_e, title) => {
      if (title === 'cd:ru' || title === 'cd:en') settle({ lang: title.slice(3) as Lang, chosen: true })
    })
    // Окно убили извне (Cmd+Q и т.п.) — старт не вешаем, берём предложенный.
    win.on('closed', () => settle({ lang: suggested, chosen: false }))
    win.once('ready-to-show', () => {
      win.webContents
        .executeJavaScript('document.querySelector(".wrap").offsetHeight')
        .then((h: number) => {
          if (!win.isDestroyed() && h > 0) win.setContentSize(380, Math.ceil(h))
        })
        .catch(() => undefined)
      win.show()
    })
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(suggested)))
  })
}
