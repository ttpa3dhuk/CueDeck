import { getState } from '../shared/bus'
import { t } from '../../shared/i18n'

let families: string[] | null = null
let pending: Promise<void> | null = null
const controls = [['timer-font', 'timer-font-status'], ['at-font', 'at-font-status']] as const

export function syncTimerFontSelect(id: string, selected: string): void {
  const select = document.getElementById(id) as HTMLSelectElement | null
  if (!select) return
  if (![...select.options].some(option => option.value === selected)) select.add(new Option(selected, selected))
  if (select.value !== selected) select.value = selected
  const status = document.getElementById(id === 'timer-font' ? 'timer-font-status' : 'at-font-status')
  const missing = families !== null && !['system', 'mono', 'serif'].includes(selected) && !families.includes(selected)
  if (status && families !== null) status.textContent = missing ? t('Шрифт «{name}» не найден на этом компьютере. Пока используется системный.', { name: selected }) : ''

}
function populate(): void {
  const state = getState()
  for (const [id] of controls) {
    const select = document.getElementById(id) as HTMLSelectElement | null
    if (!select) continue
    const selected = id === 'timer-font' ? state.timerFont : state.audienceTimer.font
    select.replaceChildren(...[
      new Option(t('Системный'), 'system'), new Option(t('Моноширинный'), 'mono'), new Option(t('С засечками'), 'serif'),
      ...(families ?? []).map(family => new Option(family, family)),
    ])
    syncTimerFontSelect(id, selected)

  }
}
/** Called directly from a settings/refresh click: Chromium requires user activation. */
export async function refreshTimerFonts(force = false): Promise<void> {
  if (pending) return pending
  if (families && !force) { populate(); return }
  pending = (async () => {
    try {
      const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
      if (!query) throw new Error('Local font access unavailable')
      const fonts = await query.call(window)
      families = [...new Set(fonts.map(font => font.family).filter(Boolean))].sort((a, b) => a.localeCompare(b))
      populate()
    } catch {
      for (const [, statusId] of controls) {
        const status = document.getElementById(statusId)
        if (status) status.textContent = t('Не удалось получить шрифты. Нажми «Обновить список шрифтов».')
      }
    }
  })()
  try { await pending } finally { pending = null }
}

/** A click focuses the font field; arrows audition fonts without a native popup.
 * Space/Enter and Alt+Down keep the native list available. */
export function setupTimerFontBrowsing(select: HTMLSelectElement): void {
  select.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const bounds = select.getBoundingClientRect()
    // Leave the native disclosure button clickable; only the label area
    // focuses without opening the popup for immediate arrow-key browsing.
    const rtl = getComputedStyle(select).direction === 'rtl'
    const onDisclosure = rtl ? event.clientX <= bounds.left + 28 : event.clientX >= bounds.right - 28
    if (onDisclosure) return
    event.preventDefault()
    select.focus()
  })
  select.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + step))
    if (next < 0 || next === select.selectedIndex) return
    select.selectedIndex = next
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
