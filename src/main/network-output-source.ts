import { ipcMain, screen, type BrowserWindow, type NativeImage } from 'electron'
import log from 'electron-log/main'
import { acquireFrameTap, type FrameTapLease } from './frame-tap.js'
import { isGpuAudienceActive } from './gpu-audience-arbiter.js'
import { allowAudienceCapture } from './stream/streamer.js'
import { acquireGhost, createHiddenAudienceWindow, createHiddenSpeakerWindow, createOmtAudioWindow,
  getActiveWindows, ghostWindow, releaseGhost } from './windows.js'

type Role = 'audience' | 'speaker'
type Listener = (image: NativeImage) => void
interface VideoSource {
  sizes: Map<Listener, number>
  win: BrowserWindow | null
  tap: FrameTapLease | null
  watch: NodeJS.Timeout | null
  latest: NativeImage | null
}
const sources = new Map<Role, VideoSource>()
const networkAudienceWindows = new WeakSet<BrowserWindow>()

function follow(role: Role, source: VideoSource): void {
  const holder = 'network-output'
  const gpu = role === 'audience' && isGpuAudienceActive()
  const existing = gpu ? ghostWindow(role) : getActiveWindows().get(role)
  let target: BrowserWindow
  if (existing && !existing.isDestroyed()) {
    releaseGhost(role, holder)
    target = existing
  } else {
    if (gpu) return
    const height = Math.max(...source.sizes.values())
    const scale = screen.getPrimaryDisplay().scaleFactor || 1
    const widthDip = Math.round(height * 16 / 9 / scale)
    const heightDip = Math.round(height / scale)
    target = acquireGhost(role, holder, () => {
      if (role === 'speaker') return createHiddenSpeakerWindow()
      const win = createHiddenAudienceWindow(widthDip, heightDip)
      networkAudienceWindows.add(win)
      return win
    })
    if (networkAudienceWindows.has(target)) {
      const [width, currentHeight] = target.getContentSize()
      if (width !== widthDip || currentHeight !== heightDip) target.setContentSize(widthDip, heightDip)
    }
  }
  if (source.win === target && source.tap) return
  source.tap?.release()
  source.tap = null
  source.win = target
  source.latest = null
  source.tap = acquireFrameTap(target.webContents, holder, image => {
    source.latest = image
    for (const fn of source.sizes.keys()) {
      try { fn(image) } catch (error) { log.warn('network video sink:', error) }
    }
  })
  const kick = (): void => {
    if (source.win === target && !target.isDestroyed()) target.webContents.invalidate()
  }
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', kick)
  else kick()
}

/** Both encoders sample the same compositor. Senders pace their own output. */
export function acquireNetworkVideo(role: Role, _fps: number, listener: Listener, height: number): { release(): void } {
  let source = sources.get(role)
  if (!source) {
    source = { sizes: new Map(), win: null, tap: null, watch: null, latest: null }
    sources.set(role, source)
  }
  const current = source
  const release = (): void => {
    if (!current.sizes.delete(listener) || current.sizes.size) return
    if (current.watch) clearInterval(current.watch)
    current.tap?.release()
    current.win = null
    current.latest = null
    sources.delete(role)
    releaseGhost(role, 'network-output')
  }
  current.sizes.set(listener, height)
  try {
    follow(role, current)
    if (current.latest) listener(current.latest)
    if (!current.watch) current.watch = setInterval(() => {
      try { follow(role, current) }
      catch (error) { log.warn('network video capture:', error) }
    }, 250)
  } catch (error) { release(); throw error }
  return { release }
}

export interface ProgramAudioChunk {
  sampleRate: number
  channels: number
  frames: number
  data: Float32Array
}
const audio = new Set<(chunk: ProgramAudioChunk) => void>()
let audioWindow: BrowserWindow | null = null
let registered = false

/** One tab audio capture and resampler; both transports receive the same planar PCM. */
export function acquireProgramAudio(fn: (chunk: ProgramAudioChunk) => void): () => void {
  if (!registered) {
    ipcMain.on('omt:audio', (event, chunk: ProgramAudioChunk) => {
      if (!audioWindow || event.sender !== audioWindow.webContents || !(chunk?.data instanceof Float32Array)) return
      if (chunk.channels !== 2 || chunk.sampleRate !== 48000 || chunk.frames <= 0 || chunk.data.length !== chunk.frames * 2) return
      for (const sink of audio) {
        try { sink(chunk) } catch (error) { log.warn('network audio sink:', error) }
      }
    })
    registered = true
  }
  if (!audioWindow || audioWindow.isDestroyed()) {
    const win = createOmtAudioWindow()
    allowAudienceCapture(win)
    audioWindow = win
    win.on('closed', () => { if (audioWindow === win) audioWindow = null })
  }
  audio.add(fn)
  return () => {
    if (!audio.delete(fn) || audio.size) return
    if (audioWindow && !audioWindow.isDestroyed()) audioWindow.destroy()
    audioWindow = null
  }
}
