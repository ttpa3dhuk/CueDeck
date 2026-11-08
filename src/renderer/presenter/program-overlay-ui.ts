import { programOverlay } from '../../shared/program-overlay'
import { t } from '../../shared/i18n'
import type { AppState } from '../../preload/api'

export function editProgramOverlay(state: AppState, onError: (message: string) => void): void {
  document.getElementById('program-overlay-modal')?.remove()
  const config = programOverlay(state.programOverlay)
  const modal = document.createElement('div'); modal.className = 'modal'; modal.id = 'program-overlay-modal'
  const form = document.createElement('form'); form.className = 'modal-content'
  const title = document.createElement('h2'); title.textContent = 'Overlay'
  const hint = document.createElement('p'); hint.className = 'audio-hint'; hint.textContent = t('Один слой поверх эфира: текст или картинка, в том числе PNG с прозрачностью. Сохраняется в проекте. Заставка и затемнение перекрывают Overlay.')
  const label = (text: string, control: HTMLElement): void => { const l = document.createElement('label'); l.textContent = t(text); l.append(control); form.append(l) }
  form.append(title, hint)
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = config.enabled; label(t('Показывать Overlay'), enabled)
  const mode = document.createElement('select')
  for (const [value, name] of [['text', t('Текст')], ['image', t('Изображение')]]) { const option = document.createElement('option'); option.value = value; option.textContent = t(name); mode.append(option) }
  mode.value = config.mode; label(t('Содержимое'), mode)
  const text = document.createElement('textarea'); text.value = config.text; text.maxLength = 2000; text.rows = 3; form.append(text)
  const imageRow = document.createElement('div'); imageRow.className = 'live-field'
  const path = document.createElement('input'); path.type = 'text'; path.readOnly = true; path.value = config.path ?? ''
  const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = t('Выбрать картинку…')
  choose.onclick = async () => { const selected = await window.api.programOverlay.chooseImage(); if (selected) path.value = selected }
  imageRow.append(path, choose); form.append(imageRow)
  const reflectMode = (): void => { text.hidden = mode.value !== 'text'; imageRow.classList.toggle('hidden', mode.value !== 'image') }
  mode.onchange = reflectMode; reflectMode()
  const grid = document.createElement('div'); grid.className = 'overlay-fields'; form.append(grid)
  const numeric = new Map<string, HTMLInputElement>()
  for (const [key, name, value, min, max] of [['x', t('X, %'), config.x*100, 0, 95], ['y', t('Y, %'), config.y*100, 0, 95], ['w', t('Ширина, %'), config.w*100, 5, 100], ['h', t('Высота, %'), config.h*100, 5, 100], ['fontSize', t('Размер текста'), config.fontSize, 16, 240], ['opacity', t('Непрозрачность фона, %'), config.opacity*100, 0, 100]] as const) {
    const l = document.createElement('label'); l.textContent = t(name)
    const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1'; input.value = String(Math.round(value)); input.required = true
    numeric.set(key, input); l.append(input); grid.append(l)
  }
  const foreground = document.createElement('input'); foreground.type = 'color'; foreground.value = config.color; label(t('Цвет текста'), foreground)
  const background = document.createElement('input'); background.type = 'color'; background.value = config.background; label(t('Цвет фона'), background)
  const actions = document.createElement('div'); actions.className = 'modal-actions'
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('Отмена'); cancel.onclick = () => modal.remove()
  const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = t('Применить'); apply.className = 'primary'; actions.append(cancel, apply); form.append(actions)
  form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return
    apply.disabled = true
    const n = (key: string): number => Number(numeric.get(key)!.value)
    try {
      await window.api.programOverlay.set({ enabled: enabled.checked, mode: mode.value as 'image' | 'text', text: text.value, path: path.value || null,
        x: n('x')/100, y: n('y')/100, w: n('w')/100, h: n('h')/100, fontSize: n('fontSize'), opacity: n('opacity')/100, color: foreground.value, background: background.value })
      modal.remove()
    } catch (error) { onError(String(error)); apply.disabled = false }
  }
  modal.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') modal.remove() })
  modal.append(form); document.body.append(modal)
  if (mode.value === 'text') text.focus(); else choose.focus()
}
