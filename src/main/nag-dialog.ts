import { app, BrowserWindow, shell } from 'electron'
import { DONATE_URL } from '../shared/types.js'

/**
 * Стартовая плашка поддержки (PLAN 2.12) — «как в REAPER»: показывается первым
 * экраном при запуске, ~5 секунд закрыть нельзя, после отсчёта появляется
 * «Продолжить». Механизма снятия плашки нет сознательно (решение Азата
 * 2026-08-16): сначала смотрим, как оно живёт, ключи/лицензии — отдельной
 * итерацией, разбор схем в PLAN 2.12.1.
 *
 * Техника окна та же, что у boot-dialog.ts: frameless-окно со страницей в
 * data:-URL, ответ в main через document.title. Показывается ДО создания окон
 * приложения, поэтому физически не может вылезти на экран зала или суфлёра
 * (правило 5).
 */
const COUNTDOWN_SEC = 5

/** Страховка: если страница почему-то не ответит, boot не вешаем. */
const SAFETY_TIMEOUT_MS = 30_000

function pageHtml(version: string): string {
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
    border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 10px;
  }
  h1 { font-size: 16px; font-weight: 600; }
  .sub { font-size: 12px; color: #8b93a3; }
  p.body { font-size: 13px; line-height: 1.5; color: #c3c9d4; }
  button {
    -webkit-app-region: no-drag; width: 100%; padding: 9px 12px; font-size: 13px;
    background: #1f232c; color: #e6e8ec; border: 1px solid #2a2f3a;
    border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #2a2f3a; }
  #donate { border-color: #4c8bf5; background: #24314b; }
  #donate:hover { background: #2c3b5a; }
  #go[disabled] { color: #6b7280; cursor: default; }
  #go[disabled]:hover { background: #1f232c; }
</style></head><body><div class="wrap">
  <h1>CueDeck ${version}</h1>
  <div class="sub">Бесплатно, с открытым исходным кодом.</div>
  <p class="body">Программу делает один человек в свободное время. Если она выручает вас на мероприятиях — поддержите разработку.</p>
  ${DONATE_URL ? '<button id="donate">☕ Поддержать проект</button>' : ''}
  <button id="go" disabled>Продолжить (${COUNTDOWN_SEC})</button>
</div><script>
  var left = ${COUNTDOWN_SEC}
  var go = document.getElementById('go')
  var proceed = function () { if (!go.disabled) document.title = 'cd:go' }
  var tick = setInterval(function () {
    left -= 1
    if (left > 0) { go.textContent = 'Продолжить (' + left + ')'; return }
    clearInterval(tick)
    go.disabled = false
    go.textContent = 'Продолжить'
    go.focus()
  }, 1000)
  go.addEventListener('click', proceed)
  var donate = document.getElementById('donate')
  if (donate) donate.addEventListener('click', function () {
    document.title = 'cd:donate'
    setTimeout(function () { document.title = 'CueDeck' }, 100)
  })
  addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === 'Escape') proceed()
  })
</script></body></html>`
}

export function showNagDialog(): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 400,
      height: 260,
      useContentSize: true,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Закрыть до конца отсчёта нельзя: рамки с крестиком нет, Cmd+W не
      // работает. Сами закрываем через destroy().
      closable: false,
      alwaysOnTop: true,
      center: true,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })

    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(safety)
      resolve()
      if (!win.isDestroyed()) win.destroy()
    }
    const safety = setTimeout(settle, SAFETY_TIMEOUT_MS)

    win.webContents.on('page-title-updated', (_e, title) => {
      if (title === 'cd:donate') {
        void shell.openExternal(DONATE_URL)
        return
      }
      if (title === 'cd:go') settle()
    })
    // Окно убили извне — boot не вешаем.
    win.on('closed', settle)
    win.once('ready-to-show', () => {
      win.webContents
        .executeJavaScript('document.querySelector(".wrap").offsetHeight')
        .then((h: number) => {
          if (!win.isDestroyed() && h > 0) win.setContentSize(400, Math.ceil(h))
        })
        .catch(() => undefined)
      win.show()
    })
    void win.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(app.getVersion())),
    )
  })
}
