import type { AppState, StreamDestination, StreamSettings, StreamStatus } from '../../preload/api'
import type { StreamDestStatus, StreamSide } from '../../shared/types'
import {
  STREAM_AUDIO_KBPS,
  STREAM_FPS,
  STREAM_HEIGHTS,
  STREAM_KEYFRAME_SEC,
  STREAM_MAX_DESTINATIONS,
  STREAM_VIDEO_KBPS,
} from '../../shared/types'
import { getLang, t } from '../../shared/i18n'
import { getState, subscribe } from '../shared/bus'

/**
 * Трансляция у оператора (PLAN 2.21): кнопка STREAM в нижней панели и окно с
 * площадками, качеством и звуком. Кнопка: серая — выкл, красная — в эфире,
 * мигает жёлтым — что-то не так (площадка переподключается, нет картинки,
 * сеть не успевает). Вся логика — в main/stream/, здесь только вид.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

let modalOpen = false

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const mm = String(m).padStart(2, '0')
  const sss = String(ss).padStart(2, '0')
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`
}

function fmtMbit(kbps: number): string {
  if (kbps > 0 && kbps < 1000) return t('{n} кбит/с', { n: kbps })
  const v = kbps / 1000
  const n = Number.isInteger(v) ? String(v) : v.toFixed(1)
  return t('{n} Мбит/с', { n: getLang() === 'ru' ? n.replace('.', ',') : n })
}

function destStateText(state: string, kbps: number, error: string | null): string {
  switch (state) {
    case 'live':
      return t('в эфире · {rate}', { rate: fmtMbit(Math.max(kbps, 1)) })
    case 'connecting':
      return t('подключение…')
    case 'reconnecting':
      return t('переподключение…') + (error ? ` ${error}` : '')
    case 'error':
      return error ?? t('ошибка')
    default:
      return ''
  }
}

function save(patch: Partial<StreamSettings>): void {
  void window.api.stream.setSettings(patch)
}

// ── кнопка ──────────────────────────────────────────────────────────────────

function paintButton(s: StreamStatus): void {
  const btn = $<HTMLButtonElement>('stream-btn')
  if (!btn) return
  const live = s.running && s.destinations.some((d) => d.state === 'live')
  btn.classList.toggle('on', s.running)
  btn.classList.toggle('live', live)
  btn.classList.toggle('warn', s.running && s.warn)
  const time = $('stream-btn-time')
  time.textContent = s.running && s.startedAt ? fmtDuration(Date.now() - s.startedAt) : ''
  btn.title = !s.running
    ? t('Трансляция: площадки, ключи, качество')
    : s.reasons.length
      ? s.reasons.map((r) => `${sideLabel(r.side)} — ${r.text}`).join('\n')
      : t('Трансляция идёт — открыть')
}

// ── окно ────────────────────────────────────────────────────────────────────

function fillSelect(sel: HTMLSelectElement, values: readonly number[], label: (v: number) => string, cur: number): void {
  if (sel.options.length !== values.length) {
    sel.innerHTML = ''
    for (const v of values) {
      const o = document.createElement('option')
      o.value = String(v)
      o.textContent = label(v)
      sel.append(o)
    }
  }
  sel.value = String(cur)
}

function renderQuality(st: StreamStatus): void {
  const s = st.settings
  fillSelect($('stream-height'), STREAM_HEIGHTS, (v) => `${v}p`, s.height)
  fillSelect($('stream-fps'), STREAM_FPS, (v) => String(v), s.fps)
  const kbpsList = STREAM_VIDEO_KBPS.includes(s.videoKbps as (typeof STREAM_VIDEO_KBPS)[number])
    ? STREAM_VIDEO_KBPS
    : [...STREAM_VIDEO_KBPS, s.videoKbps].sort((a, b) => a - b)
  fillSelect($('stream-vkbps'), kbpsList, fmtMbit, s.videoKbps)
  fillSelect($('stream-key'), STREAM_KEYFRAME_SEC, (v) => t('{n} с', { n: v }), s.keyframeSec)
  fillSelect($('stream-akbps'), STREAM_AUDIO_KBPS, (v) => t('{n} кбит/с', { n: v }), s.audioKbps)
  for (const id of ['stream-height', 'stream-fps', 'stream-vkbps', 'stream-key', 'stream-akbps']) {
    $<HTMLSelectElement>(id).disabled = st.running
  }
}

function destRow(d: StreamDestination, st: StreamStatus): HTMLElement {
  const row = document.createElement('div')
  row.className = 'stream-dest'
  row.dataset.id = d.id
  const status = st.destinations.find((x) => x.id === d.id)
  // Во время эфира правится всё, кроме включённой площадки: её сначала отключить.
  const lock = st.running && d.enabled

  const update = (patch: Partial<StreamDestination>): void => {
    const list = getState().stream.settings.destinations.map((x) => (x.id === d.id ? { ...x, ...patch } : x))
    save({ destinations: list })
  }

  const on = document.createElement('input')
  on.type = 'checkbox'
  on.checked = d.enabled
  on.title = t('Вести трансляцию сюда')
  on.onchange = () => {
    if (st.running && !on.checked && status && status.state === 'live') {
      if (!window.confirm(t('Отключить трансляцию на «{name}»? Остальные площадки продолжат.', { name: d.name || d.url }))) {
        on.checked = true
        return
      }
    }
    update({ enabled: on.checked })
  }

  const name = document.createElement('input')
  name.className = 'sd-name'
  name.value = d.name
  name.placeholder = t('Название')
  name.disabled = lock
  name.onchange = () => update({ name: name.value.trim() })

  const url = document.createElement('input')
  url.className = 'sd-url'
  url.value = d.url
  url.placeholder = 'rtmp://… / rtmps://…'
  url.spellcheck = false
  url.disabled = lock
  url.onchange = () => update({ url: url.value.trim() })

  const key = document.createElement('input')
  key.className = 'sd-key'
  key.type = 'password'
  key.value = d.key
  key.placeholder = t('Ключ потока')
  key.spellcheck = false
  key.autocomplete = 'off'
  key.disabled = lock
  key.onchange = () => update({ key: key.value.trim() })

  const eye = document.createElement('button')
  eye.className = 'sd-eye'
  eye.textContent = '👁'
  eye.title = t('Показать ключ')
  eye.onclick = () => {
    key.type = key.type === 'password' ? 'text' : 'password'
  }

  const del = document.createElement('button')
  del.className = 'sd-del'
  del.textContent = '✕'
  del.title = t('Удалить площадку')
  del.disabled = lock
  del.onclick = () => {
    save({ destinations: getState().stream.settings.destinations.filter((x) => x.id !== d.id) })
  }

  row.append(on, name, url, key, eye, del, statusLine(status))
  return row
}

/** Строка под площадкой: состояние и цифры, как в статистике vMix. */
function statusLine(status: StreamDestStatus | undefined): HTMLElement {
  const stat = document.createElement('div')
  stat.className = `sd-status ${status?.state ?? 'off'}`
  if (!status) return stat
  const main = document.createElement('span')
  main.className = 'sd-state'
  main.textContent = destStateText(status.state, status.kbps, status.error)
  stat.append(main)
  const nums: string[] = [t('кадров: {n}', { n: status.framesSent.toLocaleString(getLang()) })]
  nums.push(t('потеряно: {n}', { n: status.dropped }))
  if (status.state === 'live') nums.push(t('очередь: {q} с', { q: fmtSec(status.backlogMs) }))
  if (status.ackedMB !== null) nums.push(t('сервер принял: {mb} МБ', { mb: status.ackedMB }))
  if (status.reconnects) nums.push(t('переподключений: {n}', { n: status.reconnects }))
  if (status.liveSince) nums.push(t('в эфире {time}', { time: fmtDuration(Date.now() - status.liveSince) }))
  const extra = document.createElement('span')
  extra.className = 'sd-nums'
  extra.textContent = nums.join(' · ')
  stat.append(extra)
  if (status.dropped) stat.classList.add('lossy')
  stat.title = `${main.textContent} · ${extra.textContent}`
  return stat
}

function fmtSec(ms: number): string {
  const v = (ms / 1000).toFixed(1)
  return getLang() === 'ru' ? v.replace('.', ',') : v
}

function sideLabel(side: StreamSide | undefined): string {
  return side === 'local' ? t('Компьютер') : side === 'network' ? t('Сеть') : side === 'remote' ? t('Площадка') : ''
}

function renderDiag(st: StreamStatus): void {
  // Кодировщик
  const enc = $('stream-enc')
  if (!st.running) {
    enc.textContent = ''
  } else {
    const parts = [t('Кодировщик: {fps} к/с', { fps: st.fps })]
    if (st.encoderSkipped) parts.push(t('пропущено: {n} к/с', { n: st.encoderSkipped }))
    parts.push(st.capture ? t('зал захвачен') : t('зал не захвачен'))
    enc.textContent = parts.join(' · ')
  }
  // Почему мигает
  const why = $('stream-why')
  why.replaceChildren(
    ...st.reasons.map((r) => {
      const li = document.createElement('div')
      li.className = `stream-why-row side-${r.side}`
      const b = document.createElement('b')
      b.textContent = sideLabel(r.side)
      li.append(b, document.createTextNode(` — ${r.text}`))
      return li
    }),
  )
  why.classList.toggle('hidden', !st.reasons.length)
  // Журнал
  const box = $('stream-log')
  if (box.classList.contains('hidden')) return
  const atBottom = box.scrollTop < 4
  box.replaceChildren(
    ...st.log.map((e) => {
      const row = document.createElement('div')
      row.className = `stream-log-row ${e.level}`
      const tm = new Date(e.at).toLocaleTimeString(getLang(), { hour12: false })
      row.textContent = `${tm}  ${e.side ? `[${sideLabel(e.side)}] ` : ''}${e.text}`
      return row
    }),
  )
  if (atBottom) box.scrollTop = 0
}

/** Перерисовка списка площадок — только если не редактируется поле (иначе сбивался бы курсор). */
function renderDests(st: StreamStatus): void {
  const box = $('stream-dests')
  const editing = box.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type !== 'checkbox'
  if (editing) {
    // Обновить только статусы.
    for (const d of st.settings.destinations) {
      const row = box.querySelector<HTMLElement>(`.stream-dest[data-id="${d.id}"]`)
      const fresh = destRow(d, st).querySelector('.sd-status')
      const old = row?.querySelector('.sd-status')
      if (old && fresh) old.replaceWith(fresh)
    }
    return
  }
  box.replaceChildren(...st.settings.destinations.map((d) => destRow(d, st)))
  if (!st.settings.destinations.length) {
    const empty = document.createElement('div')
    empty.className = 'stream-empty'
    empty.textContent = t('Площадок нет — добавь адрес сервера и ключ из VK, YouTube, Telegram…')
    box.append(empty)
  }
  const add = $<HTMLButtonElement>('stream-add')
  add.disabled = st.settings.destinations.length >= STREAM_MAX_DESTINATIONS
}

function renderAudio(st: StreamStatus): void {
  const s = st.settings
  $<HTMLInputElement>('stream-prog-on').checked = s.programOn
  $<HTMLInputElement>('stream-in-on').checked = s.inputOn
  const pg = $<HTMLInputElement>('stream-prog-gain')
  const ig = $<HTMLInputElement>('stream-in-gain')
  if (document.activeElement !== pg) pg.value = String(s.programGainDb)
  if (document.activeElement !== ig) ig.value = String(s.inputGainDb)
  $('stream-prog-db').textContent = dbText(s.programGainDb)
  $('stream-in-db').textContent = dbText(s.inputGainDb)
}

function dbText(db: number): string {
  if (db <= -60) return '−∞'
  return `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db)} dB`
}

async function renderInputs(): Promise<void> {
  const sel = $<HTMLSelectElement>('stream-in-dev')
  let devs = await navigator.mediaDevices.enumerateDevices()
  let ins = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  if (ins.length && ins.every((d) => !d.label)) {
    // Метки видны только после доступа к микрофону — берём и сразу отпускаем.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((x) => x.stop())
      devs = await navigator.mediaDevices.enumerateDevices()
      ins = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    } catch {
      /* доступа нет — покажем что есть */
    }
  }
  const cur = getState().stream.settings.inputLabel
  sel.innerHTML = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = t('— без входа —')
  sel.append(none)
  const labels = ins.map((d) => d.label).filter(Boolean)
  if (cur && !labels.includes(cur)) labels.push(cur)
  for (const l of labels) {
    const o = document.createElement('option')
    o.value = l
    o.textContent = ins.some((d) => d.label === l) ? l : `${l} ${t('(не подключено)')}`
    sel.append(o)
  }
  sel.value = cur ?? ''
}

function renderHead(st: StreamStatus): void {
  const go = $<HTMLButtonElement>('stream-go')
  go.textContent = st.running ? t('Остановить') : t('Начать трансляцию')
  go.classList.toggle('danger', st.running)
  go.classList.toggle('primary', !st.running)
  const status = $('stream-status')
  if (!st.running) {
    status.textContent = ''
    status.className = 'stream-status'
  } else {
    const live = st.destinations.filter((d) => d.state === 'live').length
    status.textContent = t('● В ЭФИРЕ {time} · площадок {live} из {total} · {fps} к/с', {
      time: st.startedAt ? fmtDuration(Date.now() - st.startedAt) : '',
      live,
      total: st.destinations.length,
      fps: st.fps,
    })
    status.className = `stream-status on${st.warn ? ' warn' : ''}`
  }
  const err = $('stream-error')
  const msg = st.running ? st.encoderError : null
  err.textContent = msg ?? ''
  err.classList.toggle('hidden', !msg)
}

function render(state: AppState): void {
  const st = state.stream
  paintButton(st)
  if (!modalOpen) return
  renderHead(st)
  renderDiag(st)
  renderDests(st)
  renderQuality(st)
  renderAudio(st)
}

function openModal(): void {
  modalOpen = true
  $('stream-modal').classList.remove('hidden')
  $('stream-start-error').classList.add('hidden')
  render(getState())
  void renderInputs()
}

function closeModal(): void {
  modalOpen = false
  $('stream-modal').classList.add('hidden')
}

async function goClicked(): Promise<void> {
  const st = getState().stream
  const errEl = $('stream-start-error')
  errEl.classList.add('hidden')
  if (st.running) {
    if (!window.confirm(t('Остановить трансляцию? Зрители увидят конец эфира.'))) return
    await window.api.stream.stop()
    return
  }
  const res = await window.api.stream.start()
  if (!res.ok) {
    errEl.textContent = res.error ?? t('ошибка')
    errEl.classList.remove('hidden')
  }
}

function setMeter(el: HTMLElement, v: number): void {
  // Шкала в dB: −60…0 → 0…100 %.
  const db = v > 0 ? 20 * Math.log10(v) : -60
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  el.style.width = `${pct}%`
  el.classList.toggle('hot', db > -3)
}

export function initStreamUi(): void {
  $('stream-btn').addEventListener('click', openModal)
  $('stream-close').addEventListener('click', closeModal)
  $('stream-modal').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) closeModal()
  })
  $('stream-modal').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') closeModal()
  })
  $('stream-go').addEventListener('click', () => void goClicked())
  $('stream-log-toggle').addEventListener('click', () => {
    const box = $('stream-log')
    box.classList.toggle('hidden')
    $('stream-log-copy').classList.toggle('hidden', box.classList.contains('hidden'))
    render(getState())
  })
  $('stream-log-copy').addEventListener('click', () => {
    const text = [...getState().stream.log]
      .reverse()
      .map((e) => `${new Date(e.at).toLocaleString(getLang(), { hour12: false })} ${e.level.toUpperCase()} ${e.side ? `[${sideLabel(e.side)}] ` : ''}${e.text}`)
      .join('\n')
    void navigator.clipboard.writeText(text)
  })
  $('stream-add').addEventListener('click', () => {
    const list = getState().stream.settings.destinations
    if (list.length >= STREAM_MAX_DESTINATIONS) return
    const id = `d${Date.now().toString(36)}`
    // Во время эфира новая площадка приходит выключенной: заполнить адрес и ключ,
    // потом галка — иначе подключалась бы на полуввёденном ключе.
    const enabled = !getState().stream.running
    save({ destinations: [...list, { id, name: '', url: '', key: '', enabled }] })
  })

  const num = (id: string): number => Number($<HTMLSelectElement>(id).value)
  $('stream-height').addEventListener('change', () => save({ height: num('stream-height') }))
  $('stream-fps').addEventListener('change', () => save({ fps: num('stream-fps') }))
  $('stream-vkbps').addEventListener('change', () => save({ videoKbps: num('stream-vkbps') }))
  $('stream-key').addEventListener('change', () => save({ keyframeSec: num('stream-key') }))
  $('stream-akbps').addEventListener('change', () => save({ audioKbps: num('stream-akbps') }))

  $('stream-prog-on').addEventListener('change', () => save({ programOn: $<HTMLInputElement>('stream-prog-on').checked }))
  $('stream-in-on').addEventListener('change', () => save({ inputOn: $<HTMLInputElement>('stream-in-on').checked }))
  $('stream-in-dev').addEventListener('change', () => save({ inputLabel: $<HTMLSelectElement>('stream-in-dev').value || null }))
  const gain = (id: string, field: 'programGainDb' | 'inputGainDb'): void => {
    const el = $<HTMLInputElement>(id)
    el.addEventListener('input', () => save({ [field]: Number(el.value) }))
    el.addEventListener('dblclick', () => save({ [field]: 0 }))
  }
  gain('stream-prog-gain', 'programGainDb')
  gain('stream-in-gain', 'inputGainDb')

  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (modalOpen) void renderInputs()
  })

  window.api.stream.onLevel(([l, r]) => {
    if (!modalOpen) return
    setMeter($('stream-meter-l'), l)
    setMeter($('stream-meter-r'), r)
  })

  subscribe((state, patch) => {
    if (patch === null || 'stream' in patch) render(state)
  })
  // Время эфира на кнопке и в окне тикает само.
  setInterval(() => {
    const s = getState()
    if (s.stream.running) render(s)
  }, 1000)
  render(getState())
}
