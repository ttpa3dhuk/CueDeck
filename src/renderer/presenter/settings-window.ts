interface Box { left: number; top: number; width: number; height: number }

/** Keep the header and bottom actions within the operator viewport. */
export function clampSettingsOffset(
  desired: { x: number; y: number }, base: Box, viewport: { width: number; height: number }, margin = 8,
): { x: number; y: number } {
  const axis = (value: number, start: number, size: number, limit: number): number => {
    const low = margin - start
    const high = limit - margin - size - start
    return high < low ? (low + high) / 2 : Math.max(low, Math.min(high, value))
  }
  return { x: axis(desired.x, base.left, base.width, viewport.width), y: axis(desired.y, base.top, base.height, viewport.height) }
}

export function setupSettingsWindow(modal: HTMLElement, close: () => void): { onOpen(): void; onClose(): void } {
  const content = modal.querySelector<HTMLElement>('.settings-modal-content')!
  const header = content.querySelector<HTMLElement>('.settings-modal-heading')!
  const dismiss = content.querySelector<HTMLButtonElement>('#settings-dismiss')!
  let offset = { x: 0, y: 0 }
  let drag: { pointerId: number; x: number; y: number; offset: typeof offset; base: Box } | null = null

  const apply = (): void => {
    content.style.transform = `translate(${offset.x}px, ${offset.y}px)`
  }
  const clampCurrent = (): void => {
    if (modal.classList.contains('hidden')) return
    const rect = content.getBoundingClientRect()
    const base = { left: rect.left - offset.x, top: rect.top - offset.y, width: rect.width, height: rect.height }
    offset = clampSettingsOffset(offset, base, { width: window.innerWidth, height: window.innerHeight })
    apply()
  }

  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, select, textarea, a, [contenteditable]')) return
    const rect = content.getBoundingClientRect()
    drag = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: { ...offset },
      base: { left: rect.left - offset.x, top: rect.top - offset.y, width: rect.width, height: rect.height },
    }
    header.setPointerCapture(event.pointerId)
    header.classList.add('dragging')
    event.preventDefault()
  })
  header.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    offset = clampSettingsOffset(
      { x: drag.offset.x + event.clientX - drag.x, y: drag.offset.y + event.clientY - drag.y },
      drag.base, { width: window.innerWidth, height: window.innerHeight },
    )
    apply()
  })
  const stop = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag = null
    header.classList.remove('dragging')
    if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId)
  }
  header.addEventListener('pointerup', stop)
  header.addEventListener('pointercancel', stop)
  dismiss.addEventListener('click', close)
  window.addEventListener('resize', clampCurrent)
  return {
    onOpen: clampCurrent,
    onClose: () => {
      if (drag && header.hasPointerCapture(drag.pointerId)) header.releasePointerCapture(drag.pointerId)
      drag = null
      header.classList.remove('dragging')
    },
  }
}
