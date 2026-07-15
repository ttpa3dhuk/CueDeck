import { BrowserWindow, shell } from 'electron'
import { DONATE_URL } from '../shared/types.js'
import type { Layout } from './layout.js'

export interface BootLayoutChoice {
  /** null — окно закрыли без выбора: оставить предложенный режим. */
  layout: Layout | null
  dontAsk: boolean
}

// Стартовый вопрос «в каком режиме работаем?» — своё frameless-окно вместо
// dialog.showMessageBox: NSAlert не умеет ни разделитель, ни плашку поддержки
// внизу (нижний слот он всегда отдаёт cancel-кнопке). Порядок кнопок — 3/2/1
// сверху вниз, ниже линия и «Поддержать проект». Заодно это база под
// nag-плашку из PLAN 2.12.
const CHOICES: { layout: Layout; label: string; hotkey: string }[] = [
  { layout: 'operator-speaker-audience', label: '3 экрана (+ суфлёр)', hotkey: '3' },
  { layout: 'presenter-audience', label: '2 экрана (ноут + проектор)', hotkey: '2' },
  { layout: 'solo', label: '1 экран (только я)', hotkey: '1' },
]

// Страница целиком в data:-URL — без отдельного renderer-entry и preload.
// Ответ уходит в main через document.title («cd:{...}» / «cd:donate»).
function pageHtml(displayCount: number, suggestedIdx: number): string {
  const buttons = CHOICES.map(
    (c, i) =>
      `<button data-i="${i}"${i === suggestedIdx ? ' class="suggested"' : ''}>${c.label}</button>`,
  ).join('')
  const keymap = JSON.stringify(
    Object.fromEntries(CHOICES.map((c, i) => [c.hotkey, i])),
  )
  const donate = DONATE_URL
    ? '<div class="sep"></div><button id="donate">☕ Поддержать проект</button>'
    : ''
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
  .sub { font-size: 13px; color: #8b93a3; }
  label.ask {
    display: flex; align-items: center; gap: 6px; font-size: 12px; color: #8b93a3;
    margin: 4px 0 6px; -webkit-app-region: no-drag; cursor: pointer;
  }
  button {
    -webkit-app-region: no-drag; width: 100%; padding: 9px 12px; font-size: 13px;
    background: #1f232c; color: #e6e8ec; border: 1px solid #2a2f3a;
    border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #2a2f3a; }
  button.suggested { border-color: #4c8bf5; background: #24314b; }
  button.suggested:hover { background: #2c3b5a; }
  .sep { border-top: 1px solid #2a2f3a; margin: 8px 0 4px; }
  #donate { background: none; border: none; color: #8b93a3; font-size: 12px; padding: 4px; }
  #donate:hover { color: #e6e8ec; background: none; }
</style></head><body><div class="wrap">
  <h1>В каком режиме работаем?</h1>
  <div class="sub">Сейчас подключено экранов: ${displayCount}.</div>
  <label class="ask"><input type="checkbox" id="ask"> Больше не спрашивать при запуске</label>
  ${buttons}
  ${donate}
</div><script>
  var pick = function (i) {
    document.title = 'cd:' + JSON.stringify({ i: i, ask: document.getElementById('ask').checked })
  }
  document.querySelectorAll('button[data-i]').forEach(function (b) {
    b.addEventListener('click', function () { pick(Number(b.dataset.i)) })
  })
  var donate = document.getElementById('donate')
  if (donate) donate.addEventListener('click', function () {
    document.title = 'cd:donate'
    setTimeout(function () { document.title = 'CueDeck' }, 100)
  })
  var keymap = ${keymap}
  addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === 'Escape') pick(${suggestedIdx})
    else if (keymap[e.key] !== undefined) pick(keymap[e.key])
  })
</script></body></html>`
}

export function askBootLayout(displayCount: number, suggested: Layout): Promise<BootLayoutChoice> {
  return new Promise((resolve) => {
    const suggestedIdx = Math.max(
      0,
      CHOICES.findIndex((c) => c.layout === suggested),
    )
    const win = new BrowserWindow({
      width: 380,
      height: 330,
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
    const settle = (choice: BootLayoutChoice): void => {
      if (settled) return
      settled = true
      resolve(choice)
      if (!win.isDestroyed()) win.close()
    }
    win.webContents.on('page-title-updated', (_e, title) => {
      if (!title.startsWith('cd:')) return
      const cmd = title.slice(3)
      if (cmd === 'donate') {
        void shell.openExternal(DONATE_URL)
        return
      }
      try {
        const parsed = JSON.parse(cmd) as { i: number; ask: boolean }
        settle({ layout: CHOICES[parsed.i]?.layout ?? null, dontAsk: Boolean(parsed.ask) })
      } catch {
        /* мусор в title — игнор */
      }
    })
    // Окно убили извне (Cmd+Q и т.п.) — не вешаем boot, оставляем предложенное.
    win.on('closed', () => settle({ layout: null, dontAsk: false }))
    win.once('ready-to-show', () => {
      // Подгоняем высоту под фактический контент (донат-плашки может не быть).
      win.webContents
        .executeJavaScript('document.querySelector(".wrap").offsetHeight')
        .then((h: number) => {
          if (!win.isDestroyed() && h > 0) win.setContentSize(380, Math.ceil(h))
        })
        .catch(() => undefined)
      win.show()
    })
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(displayCount, suggestedIdx)))
  })
}
