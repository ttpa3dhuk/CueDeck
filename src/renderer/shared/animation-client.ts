import { spriteSources } from './animation-compositor'
import { PdfLoader } from './animation-frame-loader'
import { renderForegroundPair as localPair } from './animation-foreground'
import type { AnimationAsset, AnimationInfo, AnimationRegion } from '../../shared/pdf-frames'

export class AnimationFrames {
  readonly shared = window.api.pptx.sharedAnimation
  info?: AnimationInfo
  private asset?: AnimationAsset
  private local?: PdfLoader

  async open(file: string, sha: string, signal: AbortSignal): Promise<boolean> {
    this.asset = { file, sha }
    if (this.shared) this.info = (await this.shared(this.asset)) as AnimationInfo
    else {
      const bytes = await window.api.pptx.readAnimationFrames(file, sha)
      if (!bytes || signal.aborted) return false
      this.local = new PdfLoader()
      if (!(await this.local.loadDocument(bytes)) || signal.aborted) return false
      const page = await this.local.getDocument()!.getPage(1)
      this.info = { ...page.getViewport({ scale: 1 }), pages: this.local.totalPages() }
    }
    return !signal.aborted
  }
  totalPages() {
    return this.info?.pages ?? 0
  }
  async dispose() {
    this.asset = undefined
    await this.local?.dispose()
  }
  async renderRegion(
    page: number,
    rect: AnimationRegion['rect'],
    width: number,
    signal: AbortSignal,
    alpha = false,
  ) {
    if (signal.aborted) return null
    if (!this.shared)
      return alpha
        ? ((await localPair(this.local!, page, width, signal, rect)) ?? null)
        : this.local!.renderRegion(page, rect, width, signal)
    const asset = this.asset!
    const region = { page, rect, width: alpha ? 1280 : Math.min(1920, Math.max(1, Math.floor(width))), alpha }
    const bytes = (await this.shared(asset, region)) as Uint8Array
    if (signal.aborted) return null
    const image = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
    try {
      if (signal.aborted) return null
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      canvas.getContext('2d')!.drawImage(image, 0, 0)
      spriteSources.set(canvas, { asset, region })
      return canvas
    } finally {
      image.close()
    }
  }
}

export async function renderForegroundPair(
  loader: AnimationFrames,
  page: number,
  width: number,
  signal: AbortSignal,
  rect = { x: 0, y: 0, w: 1, h: 1 },
) {
  return (await loader.renderRegion(page, rect, width, signal, true)) ?? undefined
}
