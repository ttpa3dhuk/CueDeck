import type { FileKind, SlideMedia } from '../../preload/api'
import { placeSlideOverlay, slideVideoSrc, type MediaDeck } from './video'

/** Native animated images keep their own GIF frame delays/disposal/loop count. */
export class SlideGifs {
  private images = new Map<string, HTMLImageElement>()
  private generation = ''
  constructor(private canvas: HTMLCanvasElement, private deck: MediaDeck) {}

  update(kind: FileKind | null, media: SlideMedia[], slide: number, sha: string | null, ready: boolean): void {
    const generation = `${sha}:${slide}`
    if (generation !== this.generation || kind !== 'pptx') {
      this.clear()
      this.generation = generation
    }
    if (!ready || !sha || kind !== 'pptx' || this.canvas.classList.contains('hidden')) {
      for (const image of this.images.values()) image.hidden = true
      return
    }
    const wanted = new Set<string>()
    media.filter(m => m.kind === 'gif' && m.slide === slide).forEach((m, index) => {
      const key = `${index}:${m.file}`
      wanted.add(key)
      let image = this.images.get(key)
      if (!image) {
        image = document.createElement('img')
        image.className = 'slide-gif'
        image.alt = ''
        image.style.position = 'absolute'
        image.style.pointerEvents = 'none'
        image.onerror = () => {
          image!.dataset.failed = '1'; image!.hidden = true
          window.api.diag.log('warn', 'Animated PPTX GIF failed to decode')
        }
        // Separate URL per entry/return to restart even if another role retains the GIF.
        image.src = `${slideVideoSrc(this.deck, m.file, sha)}&gif=${encodeURIComponent(`${slide}:${performance.now()}:${index}`)}`
        this.canvas.parentElement!.append(image)
        this.images.set(key, image)
      }
      image.hidden = image.dataset.failed === '1'
      placeSlideOverlay(image, this.canvas, m.rect, m.crop)
    })
    for (const [key, image] of this.images) if (!wanted.has(key)) { image.remove(); image.removeAttribute('src'); this.images.delete(key) }
  }

  clear(): void {
    for (const image of this.images.values()) { image.remove(); image.removeAttribute('src') }
    this.images.clear()
  }

  elements(): HTMLImageElement[] { return [...this.images.values()] }

  ready(): boolean {
    return [...this.images.values()].every(image => image.hidden || (image.complete && image.naturalWidth > 0))
  }
}
