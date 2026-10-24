import './audience-timer.css'
import type { AudienceTimerState } from '../../shared/audience-timer'
import { timerView } from './timer'

const FONTS = {
  system: 'system-ui, sans-serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  serif: 'Georgia, "Times New Roman", serif',
}
/** Same overlay for the actual output, operator preview and settings mockup. */
export class AudienceTimerView {
  private signature = ''
  private visible: boolean | null = null
  private fade: Animation | null = null

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return
    const element = this.element
    const firstRender = this.visible === null
    const opacity = Number(getComputedStyle(element).opacity)
    this.visible = visible
    this.fade?.cancel()
    this.fade = null
    element.setAttribute('aria-hidden', String(!visible))
    element.style.pointerEvents = visible ? '' : 'none'
    if (firstRender && !visible) {
      element.hidden = true
      element.classList.add('hidden')
      element.style.opacity = '0'
      return
    }
    // Keep the element laid out until fade-out finishes. A reversed toggle
    // starts at the current opacity instead of jumping back to an endpoint.
    element.hidden = false
    element.classList.remove('hidden')
    element.style.opacity = visible ? '1' : '0'
    const fade = element.animate(
      [{ opacity }, { opacity: visible ? 1 : 0 }],
      { duration: 500, easing: 'ease-in-out' },
    )
    this.fade = fade
    fade.onfinish = () => {
      if (this.fade !== fade) return
      this.fade = null
      if (!this.visible) {
        element.hidden = true
        element.classList.add('hidden')
      }
    }
  }

  constructor(
    private element: HTMLElement,
    private container: HTMLElement,
    private state: () => { timer: AudienceTimerState; covered?: boolean },
  ) {
    element.classList.add('audience-timer')
    new ResizeObserver(() => this.render()).observe(container)
    window.setInterval(() => this.render(), 100)
    this.render()
  }
  render(): void {
    const { timer, covered } = this.state()
    const visible = timer.visible && !covered
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    const view = timerView(timer, timer.mode)
    const signature = JSON.stringify([visible, view.text, view.color, width, height,
      timer.position, timer.scale, timer.color, timer.backgroundColor, timer.backgroundOpacity, timer.font, timer.warnColors])
    if (signature === this.signature) return
    this.signature = signature
    const element = this.element
    this.setVisible(visible)
    if (!visible || !width || !height) return
    element.textContent = view.text
    element.style.fontFamily = FONTS[timer.font]
    element.style.fontSize = `${Math.min(height * 0.12 * timer.scale, width / (view.text.length * 0.68 + 0.8))}px`
    element.style.color = timer.warnColors && view.color === 'red' ? '#ff5f57'
      : timer.warnColors && view.color === 'yellow' ? '#ffd166' : timer.color
    const alpha = Math.round(timer.backgroundOpacity * 255).toString(16).padStart(2, '0')
    element.style.backgroundColor = timer.backgroundColor ? `${timer.backgroundColor}${alpha}` : 'transparent'
    // Keep the whole timer visible even at an edge or after a resolution change.
    const halfWidth = Math.min(width / 2, element.offsetWidth / 2)
    const halfHeight = Math.min(height / 2, element.offsetHeight / 2)
    element.style.left = `${Math.min(width - halfWidth, Math.max(halfWidth, width * timer.position.x))}px`
    element.style.top = `${Math.min(height - halfHeight, Math.max(halfHeight, height * timer.position.y))}px`
  }
}
