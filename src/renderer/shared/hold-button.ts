/** Deliberate hold for destructive controls, with cancellation on release or lost focus. */
export function setupHoldButton(button: HTMLButtonElement, durationMs: number, action: () => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    button.classList.remove('holding')
  }
  const start = (): void => {
    if (button.disabled || timer !== null) return
    button.style.setProperty('--hold-duration', `${durationMs}ms`)
    button.classList.add('holding')
    timer = setTimeout(() => {
      cancel()
      if (!button.disabled) action()
    }, durationMs)
  }
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    button.focus()
    button.setPointerCapture(event.pointerId)
    start()
  })
  for (const event of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture', 'blur']) button.addEventListener(event, cancel)
  button.addEventListener('pointermove', event => {
    if (timer === null) return
    // Pointer capture keeps delivering moves after the cursor leaves the button.
    const rect = button.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancel()
  })
  button.addEventListener('keydown', event => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) start()
  })
  button.addEventListener('keyup', event => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); cancel() }
  })
  button.addEventListener('click', event => event.preventDefault())
  window.addEventListener('blur', cancel)
  document.addEventListener('visibilitychange', cancel)
}
