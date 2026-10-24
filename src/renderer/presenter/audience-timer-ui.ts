import { getState, subscribe } from '../shared/bus'
import { AudienceTimerView } from '../shared/audience-timer-view'
import { AudienceTimerBackground } from './audience-timer-background'
import { timerView } from '../shared/timer'
import { t } from '../../shared/i18n'
import { audienceTimerConfig, type AudienceTimerConfig } from '../../shared/audience-timer'

/** Appearance updates immediately; the settings preview never changes visibility or transport. */
export function setupAudienceTimerUi(openSettings: () => void, error: (message: string) => void): () => void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
  const run = (promise: Promise<void>): void => { promise.catch(() => error(t('Не удалось изменить таймер зала'))) }
  const configure = (config: Partial<AudienceTimerConfig>): void => run(window.api.audienceTimer.configure(config))
  let draft = audienceTimerConfig(getState().audienceTimer)
  let backgroundSwatch = draft.backgroundColor ?? '#000000'
  let dragging: number | null = null
  const background = new AudienceTimerBackground($<HTMLCanvasElement>('at-program-frame'), $('at-stage'))
  new AudienceTimerView($('audience-timer-preview'), $('current-slide'),
    () => ({ timer: getState().audienceTimer, covered: getState().blackout }))
  const mockup = new AudienceTimerView($('at-preview'), $('at-stage'), () => ({
    timer: { ...getState().audienceTimer, ...draft, visible: true },
  }))
  const toggle = (): void => run(getState().audienceTimer.running ? window.api.audienceTimer.pause() : window.api.audienceTimer.start())
  $('audience-timer-open').onclick = openSettings
  $('audience-timer-toggle').onclick = toggle
  $('at-panel-reset').onclick = () => run(window.api.audienceTimer.reset())
  $('audience-timer-visible').onclick = () => run(window.api.audienceTimer.setVisible(!getState().audienceTimer.visible))
  $('at-panel-mode').onchange = () => {
    configure({ mode: $<HTMLSelectElement>('at-panel-mode').value as AudienceTimerConfig['mode'] })
    $('at-panel-mode').blur()
  }
  const duration = (): void => {
    const minutes = Number($<HTMLInputElement>('at-panel-minutes').value)
    const seconds = Number($<HTMLInputElement>('at-panel-seconds').value)
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return
    configure({ durationMs: Math.max(0, Math.floor(minutes)) * 60_000 + Math.max(0, Math.min(59, Math.floor(seconds))) * 1000 })
  }
  $('at-panel-minutes').onchange = duration
  $('at-panel-seconds').onchange = duration

  const edit = (config: Partial<AudienceTimerConfig>, persist = true): void => {
    draft = audienceTimerConfig({ ...draft, ...config })
    mockup.render()
    if (persist) configure(config)
  }
  $('at-mode').onchange = () => edit({ mode: $<HTMLSelectElement>('at-mode').value as AudienceTimerConfig['mode'] }, false)
  const position = (): void => edit({ position: {
    x: Number($<HTMLInputElement>('at-x').value) / 100, y: Number($<HTMLInputElement>('at-y').value) / 100,
  } })
  $('at-x').oninput = position
  $('at-y').oninput = position
  $('at-scale').oninput = () => {
    edit({ scale: Number($<HTMLInputElement>('at-scale').value) / 100 })
    $('at-scale-value').textContent = `${Math.round(draft.scale * 100)}%`
  }
  $('at-color').oninput = () => edit({ color: $<HTMLInputElement>('at-color').value })
  $('at-background').oninput = () => {
    backgroundSwatch = $<HTMLInputElement>('at-background').value
    edit({ backgroundColor: $<HTMLInputElement>('at-transparent').checked ? null : backgroundSwatch })
  }
  $('at-transparent').onchange = () => edit({ backgroundColor: $<HTMLInputElement>('at-transparent').checked ? null : backgroundSwatch })
  $('at-opacity').oninput = () => {
    edit({ backgroundOpacity: Number($<HTMLInputElement>('at-opacity').value) / 100 })
    $('at-opacity-value').textContent = `${Math.round(draft.backgroundOpacity * 100)}%`
  }
  $('at-font').onchange = () => edit({ font: $<HTMLSelectElement>('at-font').value as AudienceTimerConfig['font'] })
  $('at-warn-colors').onchange = () => edit({ warnColors: $<HTMLInputElement>('at-warn-colors').checked })

  const value = (id: string, next: string): void => {
    const input = $<HTMLInputElement>(id)
    if (document.activeElement !== input && input.value !== next) input.value = next
  }
  const preview = $('at-preview')
  preview.onpointerdown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    preview.focus()
    dragging = event.pointerId
    preview.setPointerCapture(event.pointerId)
  }
  preview.onpointermove = (event) => {
    if (dragging !== event.pointerId) return
    const rect = $('at-stage').getBoundingClientRect()
    if (!rect.width || !rect.height) return
    edit({ position: { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height } })
    value('at-x', String(Number((draft.position.x * 100).toFixed(2))))
    value('at-y', String(Number((draft.position.y * 100).toFixed(2))))
  }
  preview.onkeydown = (event) => {
    const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const direction = delta[event.key]
    if (!direction) return
    event.preventDefault(); event.stopPropagation()
    const step = event.shiftKey ? 10 : 1
    const stage = $('at-stage')
    const left = Number.parseFloat(preview.style.left), top = Number.parseFloat(preview.style.top)
    // At an edge the view clamps its centre to keep the whole timer in frame.
    // Start nudging from that visible centre rather than an off-screen drag point.
    const x = Number.isFinite(left) && stage.clientWidth ? left / stage.clientWidth : draft.position.x
    const y = Number.isFinite(top) && stage.clientHeight ? top / stage.clientHeight : draft.position.y
    edit({ position: { x: x + direction[0] * step / background.size.width,
      y: y + direction[1] * step / background.size.height } })
    value('at-x', String(Number((draft.position.x * 100).toFixed(2))))
    value('at-y', String(Number((draft.position.y * 100).toFixed(2))))
  }
  preview.onpointerup = (event) => {
    if (dragging !== event.pointerId) return
    dragging = null
    preview.releasePointerCapture(event.pointerId)
  }
  preview.onpointercancel = () => { dragging = null }

  const begin = (): void => {
    draft = audienceTimerConfig(getState().audienceTimer)
    backgroundSwatch = draft.backgroundColor ?? backgroundSwatch
    value('at-mode', draft.mode)
    value('at-x', String(Number((draft.position.x * 100).toFixed(2))))
    value('at-y', String(Number((draft.position.y * 100).toFixed(2))))
    value('at-scale', String(Math.round(draft.scale * 100)))
    $('at-scale-value').textContent = `${Math.round(draft.scale * 100)}%`
    value('at-color', draft.color)
    value('at-background', backgroundSwatch)
    value('at-opacity', String(Math.round(draft.backgroundOpacity * 100)))
    $('at-opacity-value').textContent = `${Math.round(draft.backgroundOpacity * 100)}%`
    value('at-font', draft.font)
    $<HTMLInputElement>('at-transparent').checked = draft.backgroundColor === null
    $<HTMLInputElement>('at-warn-colors').checked = draft.warnColors
    mockup.render()
  }
  const refresh = (): void => {
    const timer = getState().audienceTimer
    $('audience-timer-readout').textContent = timerView(timer, timer.mode).text
    $('audience-timer-toggle').textContent = timer.running ? '⏸' : '▶'
    const visible = $<HTMLButtonElement>('audience-timer-visible')
    visible.classList.toggle('on', timer.visible)
    visible.setAttribute('aria-pressed', String(timer.visible))
    visible.textContent = timer.visible ? t('Скрыть') : t('В зал')
    value('at-panel-minutes', String(Math.floor(timer.durationMs / 60_000)))
    value('at-panel-seconds', String(Math.floor(timer.durationMs / 1000) % 60))
    value('at-panel-mode', timer.mode)
    $<HTMLInputElement>('at-panel-minutes').disabled = timer.mode !== 'countdown'
    $<HTMLInputElement>('at-panel-seconds').disabled = timer.mode !== 'countdown'
  }
  subscribe(refresh)
  window.setInterval(refresh, 250)
  refresh()
  begin()
  return begin
}
