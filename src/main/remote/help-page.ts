import type { RemoteSettings } from '../../shared/types.js'
import { commandTitle, REMOTE_COMMANDS, type RemoteCommand } from './commands.js'
import { getLang, t } from '../../shared/i18n.js'

/**
 * Справочная страница `GET /` — открывается кнопкой «Список команд» в
 * окне «Настройки» (⚙). Её задача — чтобы оператор на площадке настроил
 * Stream Deck за пару минут без README: готовые URL с кнопкой «копировать»,
 * OSC-адреса и живой таймер сверху (заодно проверка, что связь есть).
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function argHint(c: RemoteCommand): string {
  switch (c.arg) {
    case 'duration':
      return t('минуты: <code>5</code>, <code>0.5</code>; мин:сек <code>1:30</code>; <code>90s</code>, <code>1h</code>')
    case 'index':
      return t('номер с единицы')
    case 'number':
      return t('номер слайда')
    case 'seconds':
      return t('секунды: <code>10</code>, <code>2.5</code>, <code>1:30</code>')
    case 'enum':
      return (c.values ?? []).map((v) => `<code>${esc(v)}</code>`).join(' ')
    case 'text':
      return t('любой текст')
    default:
      return ''
  }
}

function row(c: RemoteCommand, base: string, oscPort: number): string {
  const example = c.example ? t(c.example) : ''
  const suffix = example ? `/${encodeURIComponent(example)}` : ''
  const url = `${base}/api/${c.path}${suffix}`
  const oscArg = example ? ` <span class="arg">${esc(example)}</span>` : ''
  const hint = argHint(c)
  return `<tr>
  <td><b>${esc(commandTitle(c))}</b>${hint ? `<div class="hint">${hint}</div>` : ''}</td>
  <td><div class="copy"><code>${esc(url)}</code><button data-copy="${esc(url)}">${t('копировать')}</button></div></td>
  <td><code>/cuedeck/${esc(c.path)}</code>${oscArg}<div class="hint">UDP ${oscPort}</div></td>
</tr>`
}

export function helpPage(s: RemoteSettings, hosts: string[]): string {
  const base = `http://127.0.0.1:${s.httpPort}`
  const groups = [...new Set(REMOTE_COMMANDS.map((c) => c.group))]
  const tables = groups
    .map(
      (g) => `<h2>${esc(t(g))}</h2>
<table><thead><tr><th>${t('Что делает')}</th><th>${t('URL — Stream Deck «Website» / Companion HTTP')}</th><th>OSC</th></tr></thead><tbody>
${REMOTE_COMMANDS.filter((c) => c.group === g).map((c) => row(c, base, s.oscPort)).join('\n')}
</tbody></table>`,
    )
    .join('\n')
  const lan = hosts.filter((h) => h !== '127.0.0.1')
  // Строки для скрипта страницы (живой таймер сверху) — одним объектом.
  const js = JSON.stringify({
    copied: t('скопировано'),
    copy: t('копировать'),
    modes: { countdown: t('обратный отсчёт'), stopwatch: t('секундомер'), clock: t('часы') },
    running: t('▶ идёт'),
    stopped: t('⏸ стоит'),
    duration: t('длительность'),
    program: t('Эфир: '),
    slide: t('слайд'),
    left: t('осталось'),
    video: t('ролик'),
    kv: t('ЗАСТАВКА'),
    programKv: t('Эфир: заставка'),
    programEmpty: t('Эфир пуст'),
    message: t('Сообщение спикеру: '),
    offline: t('нет связи с CueDeck'),
  })

  return `<!doctype html>
<html lang="${getLang()}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CueDeck Remote</title>
<style>
  :root { --bg:#fff; --fg:#1b1d22; --muted:#6b7280; --line:#e3e5ea; --card:#f5f6f8; --accent:#2563eb; --ok:#16a34a; --warn:#ca8a04; --bad:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121417; --fg:#e8eaed; --muted:#9aa0a8; --line:#2a2e35; --card:#1b1e23; --accent:#60a5fa; --ok:#4ade80; --warn:#facc15; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 8px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .live { display:flex; align-items:center; gap:20px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 18px; }
  .clock { font: 600 44px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .clock.green{color:var(--ok)} .clock.yellow{color:var(--warn)} .clock.red{color:var(--bad)}
  .meta { color: var(--muted); font-size: 13px; }
  .howto { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:12px; margin-top:16px; }
  .howto div { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 16px; }
  .howto h3 { margin:0 0 6px; font-size:15px; }
  .howto ol { margin:0; padding-left:20px; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; vertical-align:top; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.03em; }
  td:first-child { width: 30%; }
  code { font: 13px ui-monospace, "SF Mono", Menlo, Consolas, monospace; word-break: break-all; }
  .copy { display:flex; gap:8px; align-items:flex-start; }
  .copy code { flex:1; }
  button { font: inherit; font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; white-space:nowrap; }
  button.done { color: var(--ok); border-color: var(--ok); }
  .hint { color: var(--muted); font-size: 12px; margin-top:2px; }
  .arg { color: var(--accent); font: 13px ui-monospace, Menlo, monospace; }
  @media (max-width: 720px) { td:first-child { width:auto; } th:nth-child(3), td:nth-child(3) { display:none; } .clock { font-size: 34px; } }
</style></head>
<body><main>
<h1>${t('CueDeck — внешнее управление')}</h1>
<p class="sub">${t('Команды работают, в каком бы окне ни был фокус.')} ${
    s.lan
      ? t('Открыто для сети: {hosts}.', { hosts: lan.map((h) => `<code>${esc(h)}</code>`).join(', ') || t('сетевых адресов не найдено') })
      : t('Доступ только с этого компьютера.')
  }</p>

<div class="live">
  <div id="clock" class="clock">--:--</div>
  <div class="meta"><div id="state">${t('подключаюсь…')}</div><div id="prog"></div><div id="msg"></div></div>
</div>

<div class="howto">
  <div><h3>${t('Stream Deck — родная программа Elgato')}</h3><ol>
    <li>${t('Справа «Система» → перетащи «Веб-сайт» (Website) на кнопку.')}</li>
    <li>${t('В поле URL вставь адрес из таблицы.')}</li>
    <li>${t('Включи <b>«GET-запрос в фоне»</b> (GET request in background) — иначе будет открываться браузер.')}</li>
  </ol></div>
  <div><h3>Bitfocus Companion</h3><ol>
    <li>${t('Подключение <b>Generic HTTP Requests</b> → действие GET → тот же URL.')}</li>
    <li>${t('Или <b>Generic OSC</b>: хост <code>127.0.0.1</code>{lan}, порт <code>{port}</code>, адрес из колонки OSC.', { lan: s.lan ? t(' (или IP этого компьютера)') : '', port: s.oscPort })}</li>
    <li>${t('Показать на кнопке: <code>{base}/api/state</code> (JSON: <code>timer.text</code>, <code>program.remaining</code>, <code>video.remainingText</code>…) или просто текст — <code>/api/timer/text</code>, <code>/api/program/text</code> («3/12»), <code>/api/program/remaining</code>, <code>/api/video/remaining</code>.', { base: esc(base) })}</li>
  </ol></div>
</div>

${tables}

<p class="hint" style="margin-top:24px">${t('Аргумент можно передать и параметром: <code>{base}/api/timer/add?value=1:30</code>. В OSC команды без аргумента игнорируют «отпускание» кнопки (аргумент 0/false).', { base: esc(base) })}</p>

<script>
  const T = ${js}
  for (const b of document.querySelectorAll('button[data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy) }
      catch { const t = document.createElement('textarea'); t.value = b.dataset.copy; document.body.append(t); t.select(); document.execCommand('copy'); t.remove() }
      b.textContent = T.copied; b.classList.add('done')
      setTimeout(() => { b.textContent = T.copy; b.classList.remove('done') }, 1200)
    })
  }
  const clock = document.getElementById('clock'), st = document.getElementById('state'), msg = document.getElementById('msg'), prog = document.getElementById('prog')
  async function poll() {
    try {
      const r = await (await fetch('/api/state', { cache: 'no-store' })).json()
      clock.textContent = r.timer.text
      clock.className = 'clock ' + r.timer.color
      st.textContent = (r.timer.running ? T.running : T.stopped) + ' · ' + (T.modes[r.timer.mode] || r.timer.mode) + ' · ' + T.duration + ' ' + r.timer.durationText
      const p = r.program
      prog.textContent = p.name ? T.program + p.name + (p.total ? ' · ' + T.slide + ' ' + p.text + ' · ' + T.left + ' ' + p.remaining : '') + (r.video.active ? ' · ' + T.video + ' ' + (r.video.playing ? '▶ ' : '⏸ ') + r.video.remainingText : '') + (p.blackout ? ' · ' + T.kv : '') : (p.blackout ? T.programKv : T.programEmpty)
      msg.textContent = r.speakerMessage ? T.message + '«' + r.speakerMessage + '»' : ''
    } catch { st.textContent = T.offline; clock.className = 'clock' }
  }
  poll(); setInterval(poll, 500)
</script>
</main></body></html>`
}
