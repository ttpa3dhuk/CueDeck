import type { SlideMediaRect } from '../../shared/types'
import { placeSlideOverlay } from './video'

export interface SlideLinkAction {
  rect: SlideMediaRect
  label: string
  click: () => void
}

export class SlideLinkButtons {
  private buttons: HTMLButtonElement[] = []

  constructor(private reference: HTMLCanvasElement, private className: string) {}

  update(actions: SlideLinkAction[]): void {
    actions.forEach(({ rect, label, click }, index) => {
      let button = this.buttons[index]
      if (!button) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = this.className
        this.buttons.push(button)
        this.reference.parentElement!.append(button)
      }
      button.setAttribute('aria-label', label)
      button.onclick = click
      placeSlideOverlay(button, this.reference, rect)
    })
    for (const button of this.buttons.splice(actions.length)) button.remove()
  }
}
