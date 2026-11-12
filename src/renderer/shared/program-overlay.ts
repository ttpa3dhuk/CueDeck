import { programOverlay, type ProgramOverlayConfig } from '../../shared/program-overlay'

/** One global PROGRAM layer; it stays above slide transitions and below blackout. */
export class ProgramOverlayView {
  private root = document.createElement('div')
  private text = document.createElement('div')
  private image = document.createElement('img')
  private url: string | null = null
  private path: string | null = null
  private loading = false
  private failedPath: string | null = null
  private generation = 0
  private config = programOverlay(null)
  private aspect = 16 / 9
  private sizeChecked = 0
  private sizing = false
  constructor(private host: HTMLElement, private onError?: (message: string) => void, private mapToOutput = false) {
    this.root.className = 'program-overlay'
    this.root.style.cssText = 'position:absolute;z-index:7;pointer-events:none;overflow:hidden'
    this.text.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;padding:1.5%;white-space:pre-wrap;overflow:hidden;font-family:Arial,sans-serif;font-weight:600;line-height:1.15'
    this.image.alt = ''; this.image.style.cssText = 'width:100%;height:100%;object-fit:contain'
    this.root.append(this.text, this.image); host.append(this.root)
    this.image.onerror = () => { this.failedPath = this.path; this.image.hidden = true; window.api.diag.log('warn', 'Overlay image failed to decode'); this.onError?.('Не удалось показать картинку Overlay') }
    new ResizeObserver(() => this.position()).observe(host)
    if (mapToOutput) setInterval(() => { if (this.config.enabled) this.position() }, 1000)
    this.root.hidden = true
  }
  private position(): void {
    if (this.mapToOutput && !this.sizing && Date.now() - this.sizeChecked > 1000) {
      this.sizing = true; this.sizeChecked = Date.now()
      void window.api.monitor.audienceSize().then(size => {
        if (size.width > 0 && size.height > 0) this.aspect = size.width / size.height
        this.position()
      }).catch(() => undefined).finally(() => { this.sizing = false })
    }
    const c = this.config
    const hostW = this.host.clientWidth, hostH = this.host.clientHeight
    const w = this.mapToOutput ? Math.min(hostW, hostH * this.aspect) : hostW
    const h = this.mapToOutput ? w / this.aspect : hostH
    Object.assign(this.root.style, { left: `${(hostW-w)/2 + c.x*w}px`, top: `${(hostH-h)/2 + c.y*h}px`, width: `${c.w*w}px`, height: `${c.h*h}px` })
    this.text.style.fontSize = `${w / 1920 * c.fontSize}px`
  }
  update(value: ProgramOverlayConfig | undefined): void {
    const c = programOverlay(value); this.config = c
    this.position()
    this.root.hidden = !c.enabled
    this.text.hidden = c.mode !== 'text'; this.image.hidden = c.mode !== 'image'
    // hidden must override the text layer's explicit flex display.
    this.text.style.display = c.mode === 'text' ? 'flex' : 'none'
    this.text.textContent = c.text; this.text.style.color = c.color
    this.text.style.backgroundColor = c.background + Math.round(c.opacity * 255).toString(16).padStart(2, '0')
    if (!c.enabled || c.mode !== 'image') {
      if (this.path || this.url || this.loading) {
        this.generation++; this.path = null; this.failedPath = null; this.loading = false; this.image.removeAttribute('src')
        if (this.url) URL.revokeObjectURL(this.url)
        this.url = null
      }
      return
    }
    if (c.path === this.failedPath && c.path) { this.image.hidden = true; return }
    if (c.path === this.path && (this.url || this.loading)) return
    this.path = c.path; const generation = ++this.generation
    this.image.removeAttribute('src')
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
    if (!c.path) return
    this.loading = true
    void window.api.programOverlay.read().then(data => {
      if (generation !== this.generation || !data) return
      this.url = URL.createObjectURL(new Blob([data.bytes as BlobPart], { type: data.mime }))
      this.image.src = this.url
    }).catch(error => { if (generation === this.generation) { this.failedPath = this.path; this.image.hidden = true; this.onError?.('Не удалось прочитать картинку Overlay'); window.api.diag.log('warn', 'Overlay image read failed: ' + String(error)) } })
      .finally(() => { if (generation === this.generation) this.loading = false })
  }
}
