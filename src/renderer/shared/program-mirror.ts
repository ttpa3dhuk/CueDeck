import { programVideoSource, programVideoOwner } from '../../shared/program-source'
import type { AppState, Role, VideoState } from '../../preload/api'
import { BitmapCredit } from '../../shared/bitmap-credit'
import { canMirrorColor } from '../../shared/mirror-color'
import { MirrorPolicy } from '../../shared/mirror-policy'

type PortInfo = { key: string; id: number; mode: 'source' | 'consumer' }
type Peer = { port: MessagePort; credit: BitmapCredit<ImageBitmap>; width: number; height: number; lastClock: string }
const peerSignature = (peer: Peer, clock: string): string => `${clock}:${peer.width}:${peer.height}`
let enabled = false
let forced = false
let role: Role = 'operator'
let state: (() => AppState) | null = null
let active: Mirror | null = null
const canvases = new WeakMap<HTMLVideoElement, HTMLCanvasElement>()
const clockKey = (v: VideoState): string => `${v.playing}:${v.anchorSec}:${v.anchorAt}`
function owner(): Role {
  return programVideoOwner(state!())
}

/** A separate canvas keeps monitor rendering out of another video capture pipeline. */
export function programVideoCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  let canvas = canvases.get(video)
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.dataset.programMirror = video.id
    canvas.style.display = 'none'
    video.after(canvas)
    canvases.set(video, canvas)
  }
  return canvas
}

export async function configureProgramMirror(windowRole: Role, getState: () => AppState): Promise<void> {
  role = windowRole; state = getState
  enabled = await window.api.programMirror.available().catch(() => false)
  if (!enabled) return
  forced = await window.api.programMirror.forced().catch(() => false)
  window.addEventListener('message', event => {
    if (event.source !== window) return
    if (event.data?.type === 'cuedeck-program-port') {
      const info = event.data.metadata as PortInfo, port = event.ports[0]
      if (!port || !active || info?.key !== active.key || !Number.isSafeInteger(info.id)) { port?.close(); return }
      active.connect(info, port)
    } else if (event.data?.type === 'cuedeck-program-reset') {
      const info = event.data.metadata as PortInfo
      if (active?.key === info?.key) active.disconnect(info.id)
    }
  })
}

export function loadProgramVideo(video: HTMLVideoElement, key: string): void {
  if (!enabled) { video.src = key; video.load(); return }
  const source = role === owner()
  if (active?.video === video && active.key === key && active.source === source) return
  active?.dispose()
  active = new Mirror(video, key, source)
  window.api.programMirror.register(key)
}

export function releaseProgramVideo(video: HTMLVideoElement): void {
  if (active?.video !== video) return
  active.dispose(); active = null
  window.api.programMirror.register(null)
}

/** Returns true when a canvas owns the monitor; native clock writes must stop. */
export function syncProgramMirror(video: HTMLVideoElement, clock: VideoState): boolean {
  if (!enabled || active?.video !== video) return false
  if (active.source !== (role === owner())) loadProgramVideo(video, active.key)
  active!.tick(clock)
  return !active!.source && !active!.fallback
}

export function programVideoReady(video: HTMLVideoElement): boolean {
  if (enabled && active?.video === video && !active.source && !active.fallback) {
    return active.presentedClock === clockKey(state!().video)
  }
  return video.readyState >= 2 && !video.seeking
}

export function programClockOwner(): boolean { return !enabled || state!().layout === 'solo' || role === owner() }

class Mirror {
  readonly canvas: HTMLCanvasElement
  readonly peers = new Map<number, Peer>()
  port: MessagePort | null = null
  connection = 0
  fallback = false
  presentedClock: string | null = null
  private disposed = false
  private frameCallback = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private originalVisibility: string
  private observer: ResizeObserver | null = null
  private mutation: MutationObserver | null = null
  private snapshotClock = ''
  private lastDemand = ''
  private lastFrameAt = 0
  private requestedClock = ''
  private requestedAt = performance.now()
  private colorSafe: boolean | null = null
  private policy = new MirrorPolicy(forced)
  private producing = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private onData = (): void => { this.inspectColor(); for (const peer of this.peers.values()) peer.lastClock = ''; this.publish() }
  private onError = (): void => {
    for (const peer of this.peers.values()) peer.port.postMessage({ type: 'error' })
  }
  private onDuration = (): void => {
    if (this.source && role !== 'operator' && state!().layout !== 'solo' && active === this && programVideoSource(state!()) === this.key && Number.isFinite(this.video.duration) && this.video.duration > 0) {
      void window.api.video.setDuration(this.video.duration)
    }
  }
  private onEnded = (): void => {
    if (this.source && role !== 'operator' && state!().layout !== 'solo' && active === this && programVideoSource(state!()) === this.key) void window.api.video.ended()
  }

  constructor(readonly video: HTMLVideoElement, readonly key: string, readonly source: boolean) {
    this.canvas = programVideoCanvas(video)
    this.originalVisibility = video.style.visibility
    if (source) {
      video.crossOrigin = 'anonymous'
      video.addEventListener('loadeddata', this.onData)
      video.addEventListener('seeked', this.onData)
      video.addEventListener('error', this.onError)
      video.addEventListener('loadedmetadata', this.onDuration)
      video.addEventListener('ended', this.onEnded)
      if (video.getAttribute('src') !== key) { video.src = key; video.load() }
      else queueMicrotask(() => { if (!this.disposed) { this.onDuration(); this.onData() } })
      const frame = (): void => {
        if (this.disposed) return
        this.policy.frame(performance.now())
        this.publish()
        this.frameCallback = video.requestVideoFrameCallback(frame)
      }
      this.frameCallback = video.requestVideoFrameCallback(frame)
    } else {
      if (forced && state!().layout !== 'solo') {
        video.pause(); video.removeAttribute('src'); video.load()
        video.style.visibility = 'hidden'
      } else {
        this.fallback = true
        video.crossOrigin = 'anonymous'
        if (video.getAttribute('src') !== key) { video.src = key; video.load() }
      }
      this.observer = new ResizeObserver(() => this.align())
      this.observer.observe(video)
      this.mutation = new MutationObserver(() => this.align())
      this.mutation.observe(video, { attributes: true, attributeFilter: ['class', 'style'] })
      this.align()
    }
  }

  connect(info: PortInfo, port: MessagePort): void {
    if (this.disposed || (info.mode === 'source') !== this.source) { port.close(); return }
    if (this.source) {
      const peer: Peer = { port, credit: new BitmapCredit(), width: 0, height: 0, lastClock: '' }
      this.peers.set(info.id, peer)
      port.onmessage = event => {
        const value = event.data
        if (value?.type === 'ack' && Number.isSafeInteger(value.sequence)) { peer.credit.acknowledge(value.sequence); if (!state!().video.playing && peer.lastClock !== peerSignature(peer, clockKey(state!().video))) this.publish() }
        if (value?.type === 'demand' && Number.isFinite(value.width) && Number.isFinite(value.height)) {
          peer.width = Math.max(0, Math.min(4096, Math.ceil(value.width)))
          peer.height = Math.max(0, Math.min(4096, Math.ceil(value.height)))
          peer.lastClock = ''
          this.publish()
        }
        if (value?.type === 'refresh' && value.clock === clockKey(state!().video)) {
          peer.lastClock = ''
          this.publish()
        }
      }
      port.addEventListener('close', () => this.disconnect(info.id))
      port.start()
      port.postMessage({ type: this.policy.sharing ? 'sharing' : 'native-baseline' })
    } else {
      this.port?.close(); this.port = port; this.connection = info.id; this.lastDemand = ''
      port.onmessage = event => {
        const value = event.data
        if (value?.type === 'native-baseline') { this.useNative('Native playback baseline', true, true); return }
        if (value?.type === 'sharing') { this.activate(); return }
        if (value?.type === 'error') { this.useNative('Shared decoder failed'); return }
        if (value?.type === 'native') { this.useNative('Native color pipeline required', false, true); return }
        const bitmap = value?.bitmap
        if (!(bitmap instanceof ImageBitmap)) return
        try {
          if (this.disposed || programVideoSource(state!()) !== this.key || this.port !== port || value.key !== this.key || value.clock !== clockKey(state!().video) ||
            !Number.isFinite(value.sentAt) || Date.now() - value.sentAt > 1000) return
          if (this.fallback) {
            this.video.pause(); this.video.removeAttribute('src'); this.video.load()
            this.video.style.visibility = 'hidden'; this.fallback = false
          }
          if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
            this.canvas.width = bitmap.width; this.canvas.height = bitmap.height
          }
          this.canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
          this.canvas.dataset.source = this.key
          this.canvas.dataset.mediaTime = String(value.mediaTime)
          this.canvas.dataset.clock = value.clock
          const first = this.presentedClock === null
          this.presentedClock = value.clock
          this.lastFrameAt = performance.now()
          if (this.timer) { clearTimeout(this.timer); this.timer = null }
          if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
          if (first) this.align()
        } catch (error) { this.useNative(String(error)) }
        finally { bitmap.close(); port.postMessage({ type: 'ack', sequence: value.sequence }) }
      }
      port.onmessageerror = () => this.useNative('Shared frame could not be read')
      port.addEventListener('close', () => { if (this.port === port) this.useNative('Shared decoder disconnected') })
      port.start(); this.align()
    }
  }

  disconnect(id: number): void {
    const peer = this.peers.get(id)
    if (peer) { this.peers.delete(id); peer.credit.close(); peer.port.close() }
    if (this.connection === id) {
      if (programVideoSource(state!()) !== this.key) releaseProgramVideo(this.video)
      else this.useNative('Shared decoder changed')
    }
  }

  tick(clock: VideoState): void {
    if (this.source && this.policy.observe(performance.now(), {
      timeline: clockKey(clock), playing: clock.playing, paused: this.video.paused, ended: this.video.ended,
      visible: document.visibilityState === 'visible', width: this.video.videoWidth, height: this.video.videoHeight,
      seeking: this.video.seeking, readyState: this.video.readyState, colorSafe: this.colorSafe === true,
      consumers: [...this.peers.values()].some(peer => peer.width > 0 && peer.height > 0),
    })) {
      for (const peer of this.peers.values()) peer.port.postMessage({ type: 'sharing' })
      void window.api.diag.log('info', 'Shared program decoding enabled after a stall', { source: this.key })
      this.publish()
    }
    if (this.source && !clock.playing && this.snapshotClock !== clockKey(clock)) this.publish()
    if (!this.source) {
      const key = clockKey(clock), now = performance.now()
      if (key !== this.requestedClock) {
        this.requestedClock = key; this.requestedAt = now
        // State IPC and direct frames are independent channels. A paused frame
        // may have arrived before this state and been discarded; request it again.
        this.port?.postMessage({ type: 'refresh', clock: key })
      }
      if (!this.fallback && ((clock.playing && this.lastFrameAt > 0 && now - this.lastFrameAt > 2000) ||
        (this.presentedClock !== key && now - this.requestedAt > 5000))) this.useNative('Shared frames stalled')
      this.align()
    }
  }

  private publish(): void {
    if (this.disposed || this.producing || !this.policy.sharing || programVideoSource(state!()) !== this.key || !this.source ||
      this.video.readyState < 2 || this.video.seeking || !this.video.videoWidth) return
    this.inspectColor()
    if (!this.colorSafe) {
      for (const peer of this.peers.values()) peer.port.postMessage({ type: 'native' })
      return
    }
    const videoClock = state!().video
    if (!videoClock.playing && Math.abs(this.video.currentTime - videoClock.anchorSec) > 0.4) return
    const clock = clockKey(videoClock)
    const selected = [...this.peers.values()]
      .filter(peer => peer.width > 0 && peer.height > 0 && !peer.credit.busy &&
        (videoClock.playing || peer.lastClock !== peerSignature(peer, clock)))
      .map(peer => ({ peer, signature: peerSignature(peer, clock) }))
    if (!selected.length) return
    const scale = Math.min(1, Math.max(...selected.map(({ peer }) =>
      Math.min(peer.width / this.video.videoWidth, peer.height / this.video.videoHeight))))
    const width = Math.max(1, Math.ceil(this.video.videoWidth * scale))
    const height = Math.max(1, Math.ceil(this.video.videoHeight * scale))
    const mediaTime = this.video.currentTime
    const capturedAt = Date.now()
    this.snapshotClock = clock; this.producing = true
    // Read/resize the decoded video once. Only the small resulting bitmap is
    // cloned per receiver; each receiver still has its own independent credit.
    void (async () => {
      let bitmap: ImageBitmap | undefined, failed = false
      try {
        bitmap = await createImageBitmap(this.video, { resizeWidth: width, resizeHeight: height })
        if (this.disposed || programVideoSource(state!()) !== this.key) return
        const base = bitmap
        await Promise.allSettled(selected.map(({ peer, signature }) => peer.credit.offer(
          () => createImageBitmap(base),
          (copy, sequence) => {
            peer.port.postMessage({ bitmap: copy, sequence, key: this.key, clock, mediaTime, sentAt: capturedAt }, [copy])
            peer.lastClock = signature
          }, error => {
            failed = true
            void window.api.diag.log('warn', 'Shared program frame failed', String(error))
            peer.port.postMessage({ type: 'error' })
          })))
      } catch (error) {
        failed = true
        void window.api.diag.log('warn', 'Shared program capture failed', String(error))
        for (const { peer } of selected) { try { peer.port.postMessage({ type: 'error' }) } catch { /* closed receiver */ } }
      } finally {
        bitmap?.close(); this.producing = false
        if (!failed && !this.disposed && !state!().video.playing && [...this.peers.values()].some(peer =>
          !peer.credit.busy && peer.lastClock !== peerSignature(peer, clockKey(state!().video)))) this.publish()
      }
    })()
  }

  private inspectColor(): void {
    if (!this.source || this.video.readyState < 2 || !this.video.videoWidth) return
    if (this.colorSafe === null) {
      try {
        const frame = new VideoFrame(this.video)
        try { this.colorSafe = canMirrorColor(frame.colorSpace) } finally { frame.close() }
      } catch { this.colorSafe = false }
    }
  }

  private activate(): void {
    if (this.disposed || this.source || !this.fallback) return
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      try {
        const scale = Math.min(1, this.video.clientWidth * devicePixelRatio / this.video.videoWidth)
        this.canvas.width = Math.max(1, Math.ceil(this.video.videoWidth * scale))
        this.canvas.height = Math.max(1, Math.ceil(this.video.videoHeight * scale))
        this.canvas.getContext('2d')!.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
        this.presentedClock = clockKey(state!().video)
      } catch { this.presentedClock = null }
    }
    this.video.pause(); this.video.removeAttribute('src'); this.video.load()
    this.video.style.visibility = 'hidden'; this.fallback = false; this.lastFrameAt = 0
    this.requestedClock = ''; this.requestedAt = performance.now()
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.useNative('Shared decoder did not recover'), 5000)
    this.align()
  }

  private align(): void {
    if (this.disposed || this.source) return
    const css = getComputedStyle(this.video)
    const w = this.video.clientWidth, h = this.video.clientHeight
    const visible = css.display !== 'none' && w > 0 && h > 0
    if (!visible && this.timer) { clearTimeout(this.timer); this.timer = null }
    if (visible && !this.fallback && this.presentedClock === null && !this.timer) {
      this.timer = setTimeout(() => this.useNative('No shared video frame within 5 seconds'), 5000)
    }
    this.canvas.className = this.video.className
    Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none',
      left: `${this.video.offsetLeft}px`, top: `${this.video.offsetTop}px`, width: `${w}px`, height: `${h}px`,
      maxWidth: css.maxWidth, maxHeight: css.maxHeight, objectFit: css.objectFit, clipPath: css.clipPath,
      zIndex: css.zIndex, visibility: 'visible',
      display: !this.fallback && this.presentedClock !== null && css.display !== 'none' && w > 0 && h > 0 ? 'block' : 'none' })
    if (this.port) {
      const width = css.display === 'none' ? 0 : Math.ceil(w * devicePixelRatio)
      const height = css.display === 'none' ? 0 : Math.ceil(h * devicePixelRatio)
      const demand = `${width}:${height}`
      if (demand !== this.lastDemand) {
        this.lastDemand = demand
        this.port.postMessage({ type: 'demand', width, height })
      }
    }
  }

  private useNative(reason: string, keepPort = false, quiet = false): void {
    if (this.disposed || this.source) return
    if (!keepPort) { const port = this.port; this.port = null; port?.close() }
    if (this.fallback) return
    this.fallback = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.canvas.style.display = 'none'
    this.video.style.visibility = this.originalVisibility
    this.video.crossOrigin = 'anonymous'; this.video.src = this.key; this.video.load()
    if (!quiet) void window.api.diag.log('warn', 'Program monitor returned to local decoding', reason)
    if (!keepPort && !quiet && this.retries === 0 && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        if (this.disposed || !this.fallback || active !== this || programVideoSource(state!()) !== this.key || this.video.classList.contains('hidden')) return
        this.retries++
        // Reconnect just this receiver. Other windows keep their own channel.
        window.api.programMirror.register(null)
        window.api.programMirror.register(this.key)
      }, 5000)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.video.cancelVideoFrameCallback(this.frameCallback)
    this.observer?.disconnect(); this.mutation?.disconnect()
    this.video.removeEventListener('loadeddata', this.onData)
    this.video.removeEventListener('seeked', this.onData)
    this.video.removeEventListener('error', this.onError)
    this.video.removeEventListener('loadedmetadata', this.onDuration)
    this.video.removeEventListener('ended', this.onEnded)
    for (const peer of this.peers.values()) { peer.credit.close(); peer.port.close() }
    this.peers.clear(); this.port?.close(); this.port = null
    this.video.style.visibility = this.originalVisibility
    this.canvas.style.display = 'none'
  }
}
