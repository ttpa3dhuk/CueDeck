import type { AppState, SlideMediaRect } from '../../shared/types'
import { LINK_BACKDROPS_PDF } from '../../shared/slide-link-backdrop'
import { AnimationFrames } from './animation-client'
import { placeSlideOverlay } from './video'

const fullSlide = { x: 0, y: 0, w: 1, h: 1 }

export function visitedLinkCrops(state: Pick<AppState, 'slideLinks' | 'slideVisitedLinks'>, slide: number):
  Array<{ page: number; rect: SlideMediaRect }> {
  const visited = new Set(state.slideVisitedLinks?.[slide] ?? [])
  return (state.slideLinks?.[slide] ?? []).flatMap(link =>
    link.hideAfterVisit && visited.has(link.hideAfterVisit.shape)
      ? [{ page: link.hideAfterVisit.page, rect: link.rect }] : [])
}

/** Paint only the visited cell rectangles from the authored alternative backdrop. */
export class SlideVisitedLinks {
  readonly layer = document.createElement('canvas')
  private request?: { key: string; abort: AbortController; pages: Map<number, HTMLCanvasElement>; status?: 'ready' | 'failed' }

  constructor(private reference: HTMLCanvasElement, private refreshed: () => void) {
    this.layer.className = 'slide-visited-links hidden'
    this.layer.setAttribute('aria-hidden', 'true')
    reference.parentElement!.append(this.layer)
  }

  clear(): void {
    const request = this.request
    if (request) {
      request.abort.abort()
      for (const canvas of request.pages.values()) canvas.width = canvas.height = 0
    }
    this.request = undefined
    this.layer.width = this.layer.height = 0
    this.layer.classList.add('hidden')
  }

  settled(): boolean { return this.request?.status !== undefined }

  update(state: AppState): void {
    const slide = state.currentSlide
    const crops = state.fileKind === 'pptx' ? visitedLinkCrops(state, slide) : []
    if (!crops.length || !state.pdfSha1) { this.clear(); return }
    const width = Math.min(this.reference.clientWidth, 1280 / (window.devicePixelRatio || 1))
    if (width < 1) return
    const pages = [...new Set(crops.map(crop => crop.page))].sort((a, b) => a - b)
    const key = `${state.pdfSha1}:${slide}:${width}:${pages.join(',')}`
    if (this.request?.key !== key) {
      this.clear()
      const request = { key, abort: new AbortController(), pages: new Map<number, HTMLCanvasElement>() }
      this.request = request
      void this.load(request, state.pdfSha1, pages, width)
    }
    const request = this.request
    if (request.status !== 'ready') return
    const raster = request.pages.values().next().value
    if (!raster) return
    if (this.layer.width !== raster.width || this.layer.height !== raster.height) {
      this.layer.width = raster.width
      this.layer.height = raster.height
    }
    const ctx = this.layer.getContext('2d')!
    ctx.clearRect(0, 0, this.layer.width, this.layer.height)
    for (const { page, rect } of crops) {
      const source = request.pages.get(page)
      if (!source) continue
      const x = rect.x * source.width, y = rect.y * source.height
      const w = rect.w * source.width, h = rect.h * source.height
      ctx.drawImage(source, x, y, w, h, x, y, w, h)
    }
    placeSlideOverlay(this.layer, this.reference, fullSlide)
    this.layer.classList.remove('hidden')
  }

  private async load(request: NonNullable<SlideVisitedLinks['request']>, sha: string, pages: number[], width: number): Promise<void> {
    const loader = new AnimationFrames()
    const { signal } = request.abort
    try {
      if (!await loader.open(LINK_BACKDROPS_PDF, sha, signal)) throw new Error('Visited-link backdrop unavailable')
      for (const page of pages) {
        const raster = await loader.renderRegion(page, fullSlide, width, signal)
        if (!raster || signal.aborted) throw new Error('Visited-link page unavailable')
        request.pages.set(page, raster)
      }
      request.status = 'ready'
    } catch (error) {
      request.status = 'failed'
      if (!signal.aborted) console.warn('PPTX visited-link backdrop unavailable', error)
    } finally {
      await loader.dispose()
      if (!signal.aborted) this.refreshed()
    }
  }
}
