import { afterEach, expect, it, vi } from 'vitest'
import { setupHoldButton } from '../src/renderer/shared/hold-button'
function mount() {
  vi.useFakeTimers()
  class Button extends EventTarget {
    disabled = false
    classList = { add: vi.fn(), remove: vi.fn() }
    style = { setProperty: vi.fn() }
    focus() {}
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 30, bottom: 30 } }
  }
  const button = new Button()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', new EventTarget())
  const action = vi.fn()
  setupHoldButton(button as unknown as HTMLButtonElement, 3000, action)
  const down = () => { const event = new Event('pointerdown'); Object.assign(event, { button: 0, pointerId: 1 }); button.dispatchEvent(event) }
  return { button, action, down }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('requires a full hold and does not delete on clicks or early release', () => {
  const { button, action, down } = mount()
  button.dispatchEvent(new Event('click'));expect(action).not.toHaveBeenCalled()
  down();vi.advanceTimersByTime(2999);expect(action).not.toHaveBeenCalled()
  button.dispatchEvent(new Event('pointerup'));vi.advanceTimersByTime(20);expect(action).not.toHaveBeenCalled()
  down();vi.advanceTimersByTime(3000);expect(action).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(5000);expect(action).toHaveBeenCalledTimes(1)
})
it('cancels on leaving the button or losing the application focus, and respects disabled state', () => {
  const { button, action, down } = mount()
  down();vi.advanceTimersByTime(1000);button.dispatchEvent(new Event('pointerleave'));vi.advanceTimersByTime(4000)
  down();window.dispatchEvent(new Event('blur'));vi.advanceTimersByTime(4000)
  down();button.disabled=true;vi.advanceTimersByTime(4000)
  expect(action).not.toHaveBeenCalled()
})
it('cancels a captured pointer moved outside the button before the hold completes', () => {
  const { button, action, down } = mount()
  down()
  vi.advanceTimersByTime(1500)
  const move = new Event('pointermove')
  Object.assign(move, { clientX: 40, clientY: 15 })
  button.dispatchEvent(move)
  vi.advanceTimersByTime(4000)
  expect(action).not.toHaveBeenCalled()
})
