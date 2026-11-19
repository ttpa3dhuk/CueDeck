import { drawForegroundMotion, rasterMotion, releaseForegroundMotion, type RasterMotion } from './slide-foreground-motion'
import type { SlideForegroundMotion, SlideMedia, SlideMediaRect, SlideVideoForeground as ForegroundScene } from '../../shared/types'
import { t } from '../../shared/i18n'
import { SlideLinkButtons } from './slide-link-buttons'
import { PdfLoader } from './pdf-loader'
import { placeSlideOverlay } from './video'

const fullSlide = { x: 0, y: 0, w: 1, h: 1 }

/** Recover the foreground from two PowerPoint renders with known backgrounds. */
export function recoverForeground(black: Uint8ClampedArray, white: Uint8ClampedArray): void {
  for (let i = 0; i < black.length; i += 4) {
    const alpha = 255 - Math.round((white[i] - black[i] + white[i + 1] - black[i + 1] + white[i + 2] - black[i + 2]) / 3)
    black[i + 3] = alpha
    if (alpha > 0 && alpha < 255) {
      for (let channel = 0; channel < 3; channel++) black[i + channel] *= 255 / alpha
    }
  }
}

export class SlideVideoForeground {
  readonly layer = document.createElement('canvas')
  private buttons: SlideLinkButtons
  private request: {
    key: string
    controller: AbortController
    rules?: HTMLCanvasElement
    menu?: HTMLCanvasElement
    waiting?: HTMLCanvasElement
    buttonReadyAt: number
    buttonTimer?: number
    entryMotion?: RasterMotion
    menuMotion?: RasterMotion
    entryStarted?: number
    menuStarted?: number
    motionLoading: boolean
    menuMotionSettled?: boolean
    raf?: number
    shown?: HTMLCanvasElement
  } | null = null

  constructor(private reference: HTMLCanvasElement, anchor: HTMLVideoElement, private allowClick: boolean, private refreshed: () => void) {
    this.buttons = new SlideLinkButtons(reference, 'slide-video-menu-button')
    this.layer.className = 'slide-video-foreground hidden'
    this.layer.setAttribute('aria-hidden', 'true')
    anchor.after(this.layer)
  }

  clear(): void {
    if (!this.request) return
    this.request.controller.abort()
    window.clearTimeout(this.request.buttonTimer)
    if (this.request.raf !== undefined) window.cancelAnimationFrame(this.request.raf)
    releaseForegroundMotion(this.request.entryMotion)
    releaseForegroundMotion(this.request.menuMotion)
    for (const frame of [this.request.rules, this.request.menu, this.request.waiting]) if (frame) frame.width = frame.height = 0
    this.request = null
    this.layer.width = this.layer.height = 0
    this.layer.classList.add('hidden')
    this.buttons.update([])
  }

  update(media: SlideMedia | undefined, sha: string | null, open: boolean, anchor: number | null, menuOpenedAt?: number, entering = false): boolean {
    const scene = media?.foreground
    if (!media || !scene || !sha) { this.clear(); return true }
    const menuOpen = scene.kind === 'menu' && open
    const delay = scene.kind === 'menu' && !menuOpen ? scene.buttonDelayMs ?? 0 : 0
    const width = this.reference.clientWidth
    if (width < 1) return false
    const key = `${sha}:${scene.firstPage}:${width}`
    if (this.request?.key !== key) {
      this.clear()
      const buttonReadyAt = (anchor ?? Date.now()) + delay
      const request: NonNullable<SlideVideoForeground['request']> = { key, controller: new AbortController(), buttonReadyAt, motionLoading: Boolean(!menuOpen && scene.motion?.entry) }
      this.request = request
      const waiting = delay > 0 && buttonReadyAt > Date.now()
      if (waiting) request.buttonTimer = window.setTimeout(this.refreshed, buttonReadyAt - Date.now())
      void this.load(request, scene, sha, width, menuOpen, waiting)
    }

    const request = this.request
    // Leave the static page visible while preparing the initial foreground.
    const waiting = delay > 0 && Date.now() < request.buttonReadyAt
    const frame = menuOpen ? request.menu : waiting ? request.waiting : request.rules
    const motion = menuOpen ? (menuOpenedAt === undefined ? undefined : request.menuMotion) : request.entryMotion
    const hold = entering && !menuOpen && request.entryStarted === undefined
    let moving = false
    if (motion) {
      const now = performance.now()
      const started = hold ? now : menuOpen ? (request.menuStarted ??= now) : (request.entryStarted ??= now)
      const elapsed = now - started
      if (elapsed < motion.duration || motion.repeating) {
        drawForegroundMotion(this.layer, motion, elapsed)
        request.shown = undefined
        moving = true
        if (!hold && request.raf === undefined) request.raf = requestAnimationFrame(() => {
          request.raf = undefined
          if (this.request === request) this.refreshed()
        })
      }
    }
    if (!moving) {
      if (!frame || request.motionLoading) return Boolean(request.shown)
      if (request.shown !== frame) {
        this.layer.width = frame.width
        this.layer.height = frame.height
        this.layer.getContext('2d')!.drawImage(frame, 0, 0)
        request.shown = frame
      }
    }
    this.layer.dataset.motion = moving ? menuOpen ? 'menu' : hold ? 'entry-waiting' : 'entry' : ''
    placeSlideOverlay(this.layer, this.reference, fullSlide)
    this.layer.classList.remove('hidden')
    if (this.allowClick) {
      const follow = (target: number, shape?: string): void => { void window.api.pptx.followVideoLink(sha, media.slide, target, shape) }
      const clickActions = (media.clickActions ?? []).map(action => ({
        rect: action.rect, label: action.label,
        click: () => { void window.api.pptx.clickShape(sha, media.slide, action.shape) },
      }))
      if (scene.kind === 'return') {
        this.buttons.update([{ rect: scene.link.rect, label: t('Вернуться к выбору песни'), click: () => follow(scene.link.slide) }])
      } else if (scene.kind === 'static' || menuOpen) {
        const links = (menuOpen && moving ? [] : scene.links).map(link => ({
          rect: link.rect, label: t('Перейти к слайду {n}', { n: link.slide }), click: () => follow(link.slide, link.triggerShape),
        }))
        this.buttons.update([...clickActions, ...links])
      } else if (scene.kind === 'menu') {
        const menu = !waiting && !moving && request.menu && (!scene.motion?.menu || request.menuMotionSettled)
          ? [{ rect: scene.button, label: t('Продолжить'), click: () => { void window.api.pptx.showMenu(sha, media.slide) } }]
          : []
        this.buttons.update([...clickActions, ...menu])
      }
    }
    return true
  }

  private async load(request: NonNullable<SlideVideoForeground['request']>, scene: ForegroundScene, sha: string, width: number, menuFirst: boolean, waiting: boolean): Promise<void> {
    const loader = new PdfLoader()
    const { signal } = request.controller
    try {
      const bytes = await window.api.pptx.readAnimationFrames(scene.file, sha)
      if (signal.aborted || !bytes || !await loader.loadDocument(bytes)) return
      if (!menuFirst && scene.motion?.entry) {
        request.entryMotion = await this.loadMotion(loader, scene.motion.entry, width, signal)
        request.motionLoading = false
        if (signal.aborted) return
        this.refreshed()
      }
      const states = menuFirst ? ['menu', 'rules'] as const
        : waiting ? ['waiting', 'rules', 'menu'] as const
        : scene.kind === 'menu' ? ['rules', 'menu'] as const : ['rules'] as const
      const offset = { rules: 0, menu: 2, waiting: 4 }
      for (const state of states) {
        request[state] = await renderForegroundPair(loader, scene.firstPage + offset[state], width, signal)
        if (signal.aborted) return
        this.refreshed()
      }
      if (!menuFirst && scene.motion?.menu) {
        request.menuMotion = await this.loadMotion(loader, scene.motion.menu, width, signal)
        request.menuMotionSettled = true
        if (!signal.aborted) this.refreshed()
      }
    } catch (error) {
      if (!signal.aborted) console.warn('PPTX video foreground unavailable', error)
    } finally {
      request.motionLoading = false
      request.menuMotionSettled = true
      if (!signal.aborted) this.refreshed()
      await loader.dispose()
    }
  }

  private async loadMotion(loader: PdfLoader, motion: SlideForegroundMotion, width: number, signal: AbortSignal): Promise<RasterMotion | undefined> {
    const rasterWidth = Math.min(width, 1280 / (window.devicePixelRatio || 1))
    const base = await renderForegroundPair(loader, motion.basePage, rasterWidth, signal)
    if (!base) return undefined
    const actors: HTMLCanvasElement[] = []
    try {
      for (const actor of motion.actors) {
        const raster = await renderForegroundPair(loader, actor.page, rasterWidth, signal, actor.rect)
        if (!raster) return undefined
        actors.push(raster)
      }
      return rasterMotion(base, actors, motion)
    } finally {
      if (actors.length !== motion.actors.length) for (const canvas of [base, ...actors]) canvas.width = canvas.height = 0
    }
  }

}

export async function renderForegroundPair(loader: PdfLoader, page: number, width: number, signal: AbortSignal, region: SlideMediaRect = fullSlide): Promise<HTMLCanvasElement | undefined> {
  const black = await loader.renderRegion(page, region, width, signal)
  if (!black) return undefined
  let white: HTMLCanvasElement | null = null
  let retained = false
  try {
    white = await loader.renderRegion(page + 1, region, width, signal)
    if (!white || signal.aborted) return undefined
    const ctx = black.getContext('2d')!
    const dark = ctx.getImageData(0, 0, black.width, black.height)
    const light = white.getContext('2d')!.getImageData(0, 0, white.width, white.height)
    recoverForeground(dark.data, light.data)
    ctx.putImageData(dark, 0, 0)
    retained = true
    return black
  } finally {
    if (white) white.width = white.height = 0
    if (!retained) black.width = black.height = 0
  }
}
