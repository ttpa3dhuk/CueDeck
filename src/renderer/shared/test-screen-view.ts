import './test-screen-view.css'
import { t } from '../../shared/i18n'

export interface TestScreenOptions {
  visible: boolean
  /** Fraction of the approved artwork's brightness, usually 0.35–1.3. */
  brightness: number
  roleLabel: string
  width: number | null
  height: number | null
  refreshRate: number | null
  version: string
}

let nextInstance = 0

// These two SVGs are image sources, rasterized once by Chromium. Their filters
// no longer participate in the frame-by-frame animation of the full 4K SVG.
const imageUrl = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`
const LOGO_IMAGE = imageUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 140">
  <defs><linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#30363a"/><stop offset="1" stop-color="#535c62"/></linearGradient>
  <filter id="inset" x="-10%" y="-20%" width="120%" height="140%" color-interpolation-filters="sRGB">
    <feMorphology in="SourceAlpha" operator="erode" radius="1.5" result="eroded"/><feComposite in="SourceAlpha" in2="eroded" operator="out" result="inner-rim"/>
    <feFlood flood-color="#969fa5" flood-opacity=".35" result="rim-color"/><feComposite in="rim-color" in2="inner-rim" operator="in" result="rim"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="1.8" result="soft-alpha"/><feOffset in="soft-alpha" dx="0" dy="3.5" result="down"/>
    <feComposite in="SourceAlpha" in2="down" operator="out" result="top-edge"/><feFlood flood-color="#000000" flood-opacity=".95" result="shadow-color"/>
    <feComposite in="shadow-color" in2="top-edge" operator="in" result="shadow"/><feOffset in="soft-alpha" dx="0" dy="-2" result="up"/>
    <feComposite in="SourceAlpha" in2="up" operator="out" result="bottom-edge"/><feFlood flood-color="#aab3b9" flood-opacity=".65" result="light-color"/>
    <feComposite in="light-color" in2="bottom-edge" operator="in" result="light"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="rim"/><feMergeNode in="shadow"/><feMergeNode in="light"/></feMerge>
  </filter></defs>
  <text x="260" y="101" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-weight="600" font-size="94" letter-spacing="-4" fill="url(#face)" filter="url(#inset)">CueDeck</text>
</svg>`)
const WAVE_IMAGE = imageUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
  <g fill="none"><circle cx="256" cy="256" r="197.25" stroke="#67747c" stroke-width="16.5" opacity=".28" filter="url(#soft)"/>
  <circle cx="256" cy="256" r="203" stroke="#59666e" stroke-width="2" opacity=".42"/>
  <circle cx="256" cy="256" r="207" stroke="#000" stroke-width="1.5" opacity=".65"/>
  <circle cx="256" cy="256" r="205" stroke="#8a969e" stroke-width="1.2" opacity=".9"/></g>
</svg>`)

/** Self-contained 16:9 test pattern; no app state or media is changed here. */
export class TestScreenView {
  readonly element: HTMLDivElement
  private readonly clock: SVGTextElement
  private readonly role: SVGTextElement
  private readonly resolution: SVGTSpanElement
  private readonly frequency: SVGTSpanElement
  private readonly version: SVGTextElement
  private readonly caption: SVGGElement
  private readonly cutout: SVGRectElement
  private readonly stage: HTMLDivElement
  private readonly resizeObserver: ResizeObserver
  private lastBrightness: number | null = null
  private lastCaption = ''
  private lastStageSize = ''

  constructor(container: HTMLElement, id: string) {
    const uid = `cue-test-screen-${++nextInstance}`
    this.element = document.createElement('div')
    this.element.className = 'test-screen-view'
    this.element.dataset.testScreenId = id
    this.element.hidden = true
    this.element.style.setProperty('--test-screen-engraved-face', `url(#${uid}-engraved-face)`)
    this.element.style.setProperty('--test-screen-engraved-inset', `url(#${uid}-engraved-inset)`)
    this.element.innerHTML = `
      <div class="test-screen-view__stage">
      <svg class="test-screen-view__art" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet" role="img" aria-label="CueDeck test screen">
        <defs>
          <mask id="${uid}-outside-ring" maskUnits="userSpaceOnUse" x="0" y="0" width="1920" height="1080">
            <rect width="1920" height="1080" fill="white"/>
            <circle cx="960" cy="540" r="268" fill="black"/>
            <rect class="caption-cutout" x="680" y="842" width="560" height="202" fill="black"/>
          </mask>
          <linearGradient id="${uid}-engraved-face" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#30363a"/><stop offset="1" stop-color="#535c62"/>
          </linearGradient>
          <filter id="${uid}-engraved-inset" x="-10%" y="-20%" width="120%" height="140%" color-interpolation-filters="sRGB">
            <feMorphology in="SourceAlpha" operator="erode" radius="1.5" result="eroded"/>
            <feComposite in="SourceAlpha" in2="eroded" operator="out" result="inner-rim"/>
            <feFlood flood-color="#969fa5" flood-opacity=".35" result="rim-color"/>
            <feComposite in="rim-color" in2="inner-rim" operator="in" result="rim"/>
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.8" result="soft-alpha"/>
            <feOffset in="soft-alpha" dx="0" dy="3.5" result="down"/>
            <feComposite in="SourceAlpha" in2="down" operator="out" result="top-edge"/>
            <feFlood flood-color="#000000" flood-opacity=".95" result="shadow-color"/>
            <feComposite in="shadow-color" in2="top-edge" operator="in" result="shadow"/>
            <feOffset in="soft-alpha" dx="0" dy="-2" result="up"/>
            <feComposite in="SourceAlpha" in2="up" operator="out" result="bottom-edge"/>
            <feFlood flood-color="#aab3b9" flood-opacity=".65" result="light-color"/>
            <feComposite in="light-color" in2="bottom-edge" operator="in" result="light"/>
            <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="rim"/><feMergeNode in="shadow"/><feMergeNode in="light"/></feMerge>
          </filter>
        </defs>
        <g mask="url(#${uid}-outside-ring)">
          <path class="axis" d="M960 0V1080 M0 540H1920"/>
          <path class="axis diagonal" d="M0 0L1920 1080 M1920 0L0 1080"/>
        </g>
        <rect class="frame" x="4" y="4" width="1912" height="1072"/>
        <circle class="ring" cx="960" cy="540" r="268"/>
        <g class="screen-label">
          <text class="screen-caption role-label" x="960" y="884"></text>
          <text class="screen-caption screen-caption-mode" x="960" y="927"><tspan class="resolution-label"></tspan><tspan class="screen-caption-hz"></tspan></text>
          <text class="screen-caption screen-caption-ratio" x="960" y="968">16:9</text>
          <text class="screen-caption screen-caption-version version-label" x="960" y="1010"></text>
        </g>
      </svg></div>`
    this.stage = this.element.querySelector<HTMLDivElement>('.test-screen-view__stage')!
    for (const phase of ['one', 'two', 'three']) {
      const wave = document.createElement('img')
      wave.className = `test-screen-view__wave ${phase}`
      wave.src = WAVE_IMAGE
      wave.alt = ''
      wave.draggable = false
      this.stage.prepend(wave)
    }
    const logo = document.createElement('img')
    logo.className = 'test-screen-view__logo'
    logo.src = LOGO_IMAGE
    logo.alt = ''
    logo.draggable = false
    this.stage.append(logo)
    this.clock = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    this.clock.classList.add('screen-caption', 'screen-clock')
    this.clock.setAttribute('x', '960')
    this.clock.setAttribute('y', '136')
    this.clock.setAttribute('dominant-baseline', 'central')
    this.element.querySelector('svg')!.append(this.clock)
    const updateClock = (): void => {
      if (this.element.hidden) return
      const now = new Date()
      this.clock.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join(':')
    }
    window.setInterval(updateClock, 250)
    this.role = this.element.querySelector<SVGTextElement>('.role-label')!
    this.resolution = this.element.querySelector<SVGTSpanElement>('.resolution-label')!
    this.frequency = this.element.querySelector<SVGTSpanElement>('.screen-caption-hz')!
    this.version = this.element.querySelector<SVGTextElement>('.version-label')!
    this.caption = this.element.querySelector<SVGGElement>('.screen-label')!
    this.cutout = this.element.querySelector<SVGRectElement>('.caption-cutout')!
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    container.append(this.element)
    this.resizeObserver = new ResizeObserver(() => this.resizeStage())
    this.resizeObserver.observe(this.element)
  }

  show(options: TestScreenOptions): void {
    const hidden = !options.visible
    if (this.element.hidden !== hidden) this.element.hidden = hidden
    if (!options.visible) return
    const now = new Date()
    this.clock.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join(':')
    this.resizeStage()
    const brightness = Number.isFinite(options.brightness) ? Math.max(0, Math.min(1.3, options.brightness)) : .72
    if (brightness !== this.lastBrightness) {
      this.element.style.setProperty('--test-screen-brightness', String(brightness))
      this.lastBrightness = brightness
    }
    const resolution = Number.isFinite(options.width) && Number.isFinite(options.height) &&
      (options.width ?? 0) > 0 && (options.height ?? 0) > 0
      ? `${options.width} × ${options.height}` : ''
    const frequency = options.refreshRate !== null && Number.isFinite(options.refreshRate) && options.refreshRate > 0
      ? `${resolution ? ' · ' : ''}${Number(options.refreshRate.toFixed(2))} ${t('Гц')}` : ''
    const version = options.version ? `v${options.version.replace(/^v/i, '')}` : ''
    const captionKey = JSON.stringify([options.roleLabel, resolution, frequency, version])
    if (captionKey === this.lastCaption) return
    this.lastCaption = captionKey
    this.role.textContent = options.roleLabel
    this.resolution.textContent = resolution
    this.frequency.textContent = frequency
    this.version.textContent = version
    this.centerCaption()
    void document.fonts.ready.then(() => { if (!this.element.hidden) this.centerCaption() })
  }

  private resizeStage(): void {
    const { width, height } = this.element.getBoundingClientRect()
    if (!width || !height) return
    const stageWidth = Math.min(width, height * 16 / 9)
    const size = `${stageWidth}x${stageWidth * 9 / 16}`
    if (size === this.lastStageSize) return
    this.lastStageSize = size
    this.stage.style.width = `${stageWidth}px`
    this.stage.style.height = `${stageWidth * 9 / 16}px`
  }

  private centerCaption(): void {
    this.caption.removeAttribute('transform')
    const bounds = this.caption.getBBox()
    if (!bounds.width || !bounds.height) return
    const dx = 960 - bounds.x - bounds.width / 2
    const dy = 942 - bounds.y - bounds.height / 2
    this.caption.setAttribute('transform', `translate(${dx} ${dy})`)
    this.cutout.setAttribute('x', String(bounds.x + dx - 18))
    this.cutout.setAttribute('y', String(bounds.y + dy - 12))
    this.cutout.setAttribute('width', String(bounds.width + 36))
    this.cutout.setAttribute('height', String(bounds.height + 24))
  }
}
