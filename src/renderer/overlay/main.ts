import type { AppState } from '../../preload/api'
import { getState, initBus, subscribe } from '../shared/bus'
import { startTick, timerView } from '../shared/timer'

/**
 * Таймер для выхода OMT (main/omt/outputs.ts). Окно offscreen и никогда не
 * показывается: main снимает его кадры вместе с прозрачностью и отдаёт в сеть.
 * Цвет — как на суфлёре (свой цвет таймера и жёлтый/красный в конце).
 */

const timerEl = document.getElementById('timer') as HTMLDivElement
const messageEl = document.getElementById('message') as HTMLDivElement

function setOrClear(name: string, v: string | null): void {
  const root = document.documentElement.style
  if (v) root.setProperty(name, v)
  else root.removeProperty(name)
}

function applyColors(state: AppState): void {
  const c = state.timerColor
  setOrClear('--speaker-timer-green', c)
  setOrClear('--speaker-timer-yellow', c && !state.timerWarnColors ? c : null)
  setOrClear('--speaker-timer-red', c && !state.timerWarnColors ? c : null)
}

function applyMessage(state: AppState): void {
  const msg = state.omt.timerMessage ? state.speakerMessage : null
  if (messageEl.textContent !== (msg ?? '')) messageEl.textContent = msg ?? ''
  messageEl.classList.toggle('hidden', !msg)
}

function renderTimer(): void {
  const state = getState()
  const view = timerView(state.timer, state.timerMode)
  const cls = `timer ${view.color}${view.overtime ? ' overtime' : ''}`
  if (timerEl.className !== cls) timerEl.className = cls
  if (timerEl.textContent !== view.text) timerEl.textContent = view.text
  const chars = String(view.text.length)
  if (timerEl.style.getPropertyValue('--timer-chars') !== chars) timerEl.style.setProperty('--timer-chars', chars)
}

async function bootstrap(): Promise<void> {
  const state = await initBus()
  applyColors(state)
  applyMessage(state)
  subscribe((s) => {
    applyColors(s)
    applyMessage(s)
    renderTimer()
  })
  startTick(250, renderTimer)
}

bootstrap().catch((err) => {
  window.api.diag.log('error', 'omt overlay: bootstrap упал', String(err))
})
