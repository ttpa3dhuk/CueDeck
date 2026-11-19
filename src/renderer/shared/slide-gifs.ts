import type { FileKind, SlideMedia } from '../../preload/api'
import { placeSlideOverlay, slideVideoSrc, type MediaDeck } from './video'
import { GifPlayer, gifDecoder } from './gif-player'
import { GifByteCache } from './gif-byte-cache'

const bytesCache = new GifByteCache()
export function gifCacheStats(): ReturnType<GifByteCache['stats']> { return bytesCache.stats() }
function readGif(file: string, sha: string, deck: MediaDeck): Promise<Uint8Array | null> {
  // The prepared SHA identifies identical immutable bytes in program and preview.
  return bytesCache.read(`${sha}:${file}`, () => window.api.pptx.readGif(file, sha, deck))
}

/** Decode sequentially where supported; keep native images as a compatibility fallback. */
export class SlideGifs {
  private images = new Map<string, HTMLImageElement | HTMLCanvasElement>()
  private players = new WeakMap<HTMLCanvasElement, GifPlayer>()
  private generation = ''
  constructor(private canvas: HTMLCanvasElement, private deck: MediaDeck) {}

  update(kind: FileKind | null, media: SlideMedia[], slide: number, sha: string | null, ready: boolean): void {
    const generation = `${sha}:${slide}`
    if (generation !== this.generation || kind !== 'pptx') {
      this.clear()
      this.generation = generation
    }
    if (!ready || !sha || kind !== 'pptx' || this.canvas.classList.contains('hidden')) {
      // display:none/hidden alone keeps the animated image and decoder alive.
      this.clear()
      return
    }
    const wanted = new Set<string>()
    media.filter(m => m.kind === 'gif' && m.slide === slide).forEach((m, index) => {
      const key = `${index}:${m.file}`
      wanted.add(key)
      let image = this.images.get(key)
      if (!image) {
        if (gifDecoder()) {
          const canvas = document.createElement('canvas')
          const player = new GifPlayer(canvas)
          this.players.set(canvas, player)
          canvas.width = 0; canvas.height = 0
          image = canvas
          // The owner check rejects a completed read after a slide/deck change.
          void readGif(m.file, sha, this.deck).then(async bytes => {
            if (this.images.get(key) !== canvas) return
            if (!bytes) throw new Error('GIF data unavailable')
            await player.start(bytes)
          }).catch(() => {
            if (this.images.get(key) !== canvas) return
            player.stop()
            const native = this.nativeImage(m.file, sha, slide, index)
            native.style.cssText = canvas.style.cssText
            canvas.replaceWith(native)
            this.images.set(key, native)
          })
        } else image = this.nativeImage(m.file, sha, slide, index)
        image.className = 'slide-gif'
        image.style.position = 'absolute'
        image.style.pointerEvents = 'none'
        this.canvas.parentElement!.append(image)
        this.images.set(key, image)
      }
      image.hidden = image.dataset.failed === '1'
      placeSlideOverlay(image, this.canvas, m.rect, m.crop)
    })
    for (const [key, image] of this.images) if (!wanted.has(key)) { this.release(image); this.images.delete(key) }
  }

  private nativeImage(file: string, sha: string, slide: number, index: number): HTMLImageElement {
    const image = document.createElement('img')
    image.alt = ''
    image.className = 'slide-gif'
    image.onerror = () => {
      image.dataset.failed = '1'; image.hidden = true
      window.api.diag.log('warn', 'Animated PPTX GIF failed to decode')
    }
    // Fallback retains the existing restart behavior on older Chromium builds.
    image.src = `${slideVideoSrc(this.deck, file, sha)}&gif=${encodeURIComponent(`${slide}:${performance.now()}:${index}`)}`
    return image
  }

  private release(image: HTMLImageElement | HTMLCanvasElement): void {
    const player = this.players.get(image as HTMLCanvasElement)
    player?.stop()
    image.onerror = null
    image.removeAttribute('src')
    image.remove()
  }

  clear(): void {
    for (const image of this.images.values()) this.release(image)
    this.images.clear()
  }

  elements(): Array<HTMLImageElement | HTMLCanvasElement> { return [...this.images.values()] }

  ready(): boolean {
    return [...this.images.values()].every(image => image.hidden || image.dataset.failed === '1' ||
      (this.players.get(image as HTMLCanvasElement)?.ready ?? ((image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)))
  }
}
