/**
 * Single real audience GPU producer for Syphon and Spout.
 *
 * The producer is the actual audience renderer: same preload, state bus, media
 * protocol, blackout/keyvisual/Fade code. It is rendered once, offscreen, with a
 * shared texture, and is registered as the single `audience` ghost.
 *
 * The physical audience, when present, is a display-only GPU mirror of this
 * source. It never registers as the audience role or decodes media again.
 * Stream and OMT program acquisition stop this mode before taking a normal
 * audience renderer; neither consumer is disabled here.
 * - stopping keeps one in-flight JS texture until native completion and the
 *   manager blocks a new start if that completion does not arrive within a
 *   bounded deadline. Repeated off/on therefore cannot accumulate held textures;
 * Packaged builds load native resources from the application bundle; Syphon
 * requires macOS 13 or later.
 */
import { app, type BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { existsSync } from 'node:fs'
import { localGpuNativePath, macSyphonSupported } from './local-gpu-path.js'
import { store } from './state.js'
import {
  acquireGhost,
  createGpuAudienceWindow,
  getActiveWindows,
  ghostWindow,
  loadGpuAudiencePage,
  reconcileGpuAudienceDisplay,
  releaseGhost,
} from './windows.js'
import { GpuAudienceMirror } from './gpu-audience-mirror.js'
import {
  GpuTexturePublisher,
  type GpuPaintSource,
  type GpuPublisherStopResult,
} from './syphon-gpu-publisher.js'
import { cleanSyphonName } from '../shared/syphon.js'
import {
  clearGpuAudienceGuard,
  setGpuAudienceGuard,
  stopGpuAudienceForNormalOutput,
} from './gpu-audience-arbiter.js'
import {
  DEFAULT_SYPHON_SETTINGS,
  SYPHON_TARGET,
  type SyphonReason,
} from '../shared/types.js'

const HOLDER = 'gpu-audience'
const TARGET = SYPHON_TARGET
const DEFAULT_NAME = DEFAULT_SYPHON_SETTINGS.name
/** Bounded wait for the one in-flight frame after a normal stop request. */
const STOP_TIMEOUT_MS = 2000

function envFlag(name: string): boolean { return process.env[name] === '1' }
function numericEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}
function nativePath(): string {
  return localGpuNativePath(process.platform, app.isPackaged, app.getAppPath(), process.resourcesPath, process.env)
}
function omtProgramActive(state = store.get()): boolean {
  return state.omt.outputs.program.state === 'on' || state.omt.enabled.program
}

export interface GpuAudienceOptions {
  name: string
  isPublic: boolean
  flipY: boolean
  timeoutMs: number
  firstTextureMs: number
  nativePath: string
}

export interface GpuAudienceHooks {
  onFirstTexture?: () => void
  onFatal?: (reason: string) => void
  /** Synchronous: called as soon as stop starts, before native completion. */
  onStopped?: (reason: string) => void
  /** Called after the bounded native completion wait. */
  onStopResult?: (reason: string, result: GpuPublisherStopResult) => void
}

export type GpuAudienceStartResult =
  | { ok: true }
  | { ok: false; reason: SyphonReason; detail: string }

export interface GpuAudienceStopResult {
  released: boolean
  timedOut: boolean
}

export interface GpuAudienceStatus {
  active: boolean
  failed: boolean
  reason: SyphonReason | null
  target: { width: number; height: number }
  actual: { width: number; height: number } | null
  sawTexture: boolean
  firstTextureAtMs: number
  missingTexturePaints: number
  windowId: number | null
}

function defaultOptions(): GpuAudienceOptions {
  return {
    name: cleanSyphonName(process.env.CUEDECK_SYPHON_GPU_NAME, DEFAULT_NAME),
    isPublic: envFlag('CUEDECK_SYPHON_GPU_PUBLIC'),
    flipY: envFlag('CUEDECK_SYPHON_GPU_FLIP_Y'),
    timeoutMs: numericEnv('CUEDECK_SYPHON_GPU_TIMEOUT_MS', 5000, 500, 15000),
    firstTextureMs: numericEnv('CUEDECK_SYPHON_GPU_FIRST_TEXTURE_MS', 5000, 1000, 20000),
    nativePath: nativePath(),
  }
}

export class GpuAudienceMode {
  private readonly options: GpuAudienceOptions
  private win: BrowserWindow | null = null
  private publisher: GpuTexturePublisher | null = null
  private mirror: GpuAudienceMirror | null = null
  private unsubscribe: (() => void) | null = null
  private disposed = false
  private failed = false
  private refuseReason: SyphonReason | null = null
  private errorDetail: string | null = null
  private stopPromise: Promise<GpuAudienceStopResult> | null = null
  private readonly guard = {
    stop: (reason: string) => { void this.stop(reason) },
    attachPhysical: (win: BrowserWindow) => {
      this.mirror?.attach(win)
      // invalidate() alone does not request a new captured GPU frame for a
      // static scene on Electron 44. Restart the capturer when a new display
      // attaches; the existing renderer/media decoder stays alive.
      const source = this.win
      if (source && !source.isDestroyed()) {
        source.webContents.stopPainting()
        source.webContents.startPainting()
        source.webContents.invalidate()
      }
    },
    detachPhysical: () => this.mirror?.detach(),
  }

  constructor(
    options: Partial<GpuAudienceOptions> = {},
    private readonly hooks: GpuAudienceHooks = {},
  ) {
    const merged = { ...defaultOptions(), ...options }
    this.options = { ...merged, name: cleanSyphonName(merged.name, DEFAULT_NAME) }
  }

  name(): string { return this.options.name }

  start(): GpuAudienceStartResult {
    if (this.disposed) return this.refuse('runtime', 'mode is disposed')
    if (!['darwin', 'win32'].includes(process.platform)) return this.refuse('platform', 'macOS or Windows only')
    if (process.platform === 'darwin' && !macSyphonSupported()) return this.refuse('macos-version', 'Syphon requires macOS 13 or later')
    if (process.env.CUEDECK_SYPHON_GPU === '1') return this.refuse('synthetic', 'CUEDECK_SYPHON_GPU=1 is active')
    if (process.env.CUEDECK_SYPHON_BRIDGE === '1') return this.refuse('cpu-bridge', 'CUEDECK_SYPHON_BRIDGE=1 is active')
    const state = store.get()
    const physicalAudience = getActiveWindows().get('audience')
    const registeredAudience = store.registeredWindow('audience')
    if (registeredAudience && registeredAudience !== physicalAudience) return this.refuse('physical-audience', 'another audience renderer is registered')
    if (ghostWindow('audience')) return this.refuse('audience-lease', 'another hidden audience lease exists')
    if (state.stream.running) return this.refuse('stream', 'stream is running')
    if (omtProgramActive(state)) return this.refuse('omt-program', 'OMT program output is running')
    if (!existsSync(this.options.nativePath)) {
      return this.refuse('native-missing', `native publisher not found: ${this.options.nativePath}`)
    }
    if (!GpuAudienceMirror.available()) return this.refuse('runtime', 'shared texture display import is unavailable')

    try {
      this.mirror = new GpuAudienceMirror((error) => this.fail(`GPU display: ${error.message}`))
      setGpuAudienceGuard(this.guard)
      reconcileGpuAudienceDisplay()
      const win = acquireGhost('audience', HOLDER, () =>
        createGpuAudienceWindow(TARGET.width, TARGET.height, false), 'gpu-audience')
      this.win = win
      this.publisher = new GpuTexturePublisher(
        {
          nativePath: this.options.nativePath,
          name: this.options.name,
          isPublic: this.options.isPublic,
          flipY: this.options.flipY,
          timeoutMs: this.options.timeoutMs,
          firstTextureMs: this.options.firstTextureMs,
          targetSize: TARGET,
          consumeFrame: (info) => this.mirror!.consume(info),
        },
        () => this.source(),
        (reason) => this.fail(reason),
        () => this.hooks.onFirstTexture?.(),
      )
      win.webContents.on('paint', (event) => {
        if (this.publisher) this.publisher.onPaint(event)
        else try { event.texture?.release() } catch { /* window is stopping */ }
      })
      win.webContents.once('did-finish-load', () => {
        if (this.disposed || win.isDestroyed()) return
        const [dipW, dipH] = win.getContentSize()
        log.info(`syphon-gpu-audience: real audience page loaded url=${win.webContents.getURL()} ` +
          `content=${dipW}x${dipH} DIP, target=${TARGET.width}x${TARGET.height} physical; ` +
          'actual texture size is logged by the publisher')
        win.webContents.startPainting()
        win.webContents.invalidate()
      })
      win.webContents.once('did-fail-load', (_e, code, desc) => this.fail(`audience page load: ${code} ${desc}`))
      this.publisher.start()
      if (this.failed || this.disposed) {
        return { ok: false, reason: 'runtime', detail: this.errorDetail ?? 'GPU publisher failed' }
      }
      try { loadGpuAudiencePage(win) } catch (error) {
        const detail = `load audience page: ${(error as Error).message}`
        void this.stop(`failure: ${detail}`)
        return { ok: false, reason: 'runtime', detail }
      }
      this.unsubscribe = store.onChange((next) => {
        if (this.disposed) return
        if (next.stream.running) void this.stop('conflict:stream')
        else if (omtProgramActive(next)) void this.stop('conflict:omt-program')
      })
      win.once('closed', () => {
        if (!this.disposed && this.win === win) void this.stop('window-closed')
      })
      log.info(
        `syphon-gpu-audience: ON, single offscreen audience renderer, target ${TARGET.width}x${TARGET.height} ` +
        `physical, server=${this.options.isPublic ? 'PUBLIC' : 'private'}, ` +
        `flipY=${this.options.flipY ? 1 : 0}, name="${this.options.name}"`,
      )
      return { ok: true }
    } catch (error) {
      const detail = `create: ${(error as Error).message}`
      void this.stop(`failure: ${detail}`)
      return { ok: false, reason: 'runtime', detail }
    }
  }

  stop(reason: string): Promise<GpuAudienceStopResult> {
    if (this.stopPromise) return this.stopPromise
    if (this.disposed) return Promise.resolve({ released: true, timedOut: false })
    this.disposed = true
    this.hooks.onStopped?.(reason)
    this.unsubscribe?.()
    this.unsubscribe = null
    clearGpuAudienceGuard(this.guard)
    const publisher = this.publisher
    this.publisher = null
    // Destroy the renderer and free the audience lease synchronously: a normal
    // output may take over immediately. Only the hardware frame stays in flight.
    try {
      if (this.win && !this.win.isDestroyed()) this.win.destroy()
    } catch (error) {
      log.warn(`syphon-gpu-audience: window destroy: ${(error as Error).message}`)
    }
    this.win = null
    try { releaseGhost('audience', HOLDER) } catch (error) {
      log.warn(`syphon-gpu-audience: ghost release: ${(error as Error).message}`)
    }
    this.mirror?.detach()
    this.mirror = null
    reconcileGpuAudienceDisplay()
    const wait = publisher ? publisher.stopAndWait(STOP_TIMEOUT_MS) : Promise.resolve({ released: true, timedOut: false })
    this.stopPromise = wait.then((result) => {
      this.hooks.onStopResult?.(reason, result)
      log.info(`syphon-gpu-audience: stopped (${reason}), released=${result.released}, timedOut=${result.timedOut}`)
      return result
    }).catch((error: unknown) => {
      const result = { released: false, timedOut: true }
      this.hooks.onStopResult?.(reason, result)
      log.warn(`syphon-gpu-audience: stop failed: ${(error as Error).message}`)
      return result
    })
    return this.stopPromise
  }

  status(): GpuAudienceStatus {
    const pub = this.publisher?.status()
    return {
      active: !this.disposed && this.publisher !== null,
      failed: this.failed,
      reason: this.refuseReason,
      target: { ...TARGET },
      actual: pub && pub.width > 0 ? { width: pub.width, height: pub.height } : null,
      sawTexture: pub?.sawTexture ?? false,
      firstTextureAtMs: pub?.firstTextureAtMs ?? 0,
      missingTexturePaints: pub?.missingTexturePaints ?? 0,
      windowId: this.win && !this.win.isDestroyed() ? this.win.id : null,
    }
  }

  private source(): GpuPaintSource | null {
    const win = this.win
    if (!win || win.isDestroyed()) return null
    return {
      webContents: win.webContents,
      isDestroyed: () => win.isDestroyed(),
      invalidate: () => win.webContents.invalidate(),
    }
  }

  private refuse(reason: SyphonReason, detail: string): { ok: false; reason: SyphonReason; detail: string } {
    this.refuseReason = reason
    log.warn(`syphon-gpu-audience: refused: ${reason} (${detail})`)
    return { ok: false, reason, detail }
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    this.errorDetail = reason
    log.error(`syphon-gpu-audience: failed: ${reason}`)
    this.hooks.onFatal?.(reason)
    void this.stop('error')
  }
}

/** Test/other-output hook: stop the experiment before a normal consumer. */
export function stopGpuAudienceForOutput(reason: string): void {
  stopGpuAudienceForNormalOutput(reason)
}
