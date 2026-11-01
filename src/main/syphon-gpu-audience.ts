/**
 * DEV-ONLY real audience GPU producer (network/solo only).
 *
 * This is the actual audience renderer: same preload, state bus, media
 * protocol, blackout/keyvisual/Fade code. It is rendered once, offscreen, with
 * shared texture, and is registered as the single `audience` ghost. It is not
 * a test canvas and not a second renderer alongside a physical audience.
 *
 * Safety policy:
 * - only when layout is solo, no physical audience window, no stream running,
 *   no OMT program output running, no existing hidden audience, no CPU bridge;
 * - physical layout / stream / OMT program acquisition stops this experiment
 *   before the normal path creates its own hidden audience;
 * - stopping may hold one JS texture until native completion; the window is
 *   destroyed so no duplicate audience renderer remains.
 */
import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { store } from './state.js'
import { acquireGhost, createGpuAudienceWindow, getActiveWindows, ghostWindow, loadGpuAudiencePage, releaseGhost } from './windows.js'
import { GpuTexturePublisher, type GpuPaintSource } from './syphon-gpu-publisher.js'
import {
  clearGpuAudienceGuard,
  setGpuAudienceGuard,
  stopGpuAudienceForNormalOutput,
} from './gpu-audience-arbiter.js'

const HOLDER = 'gpu-audience'
const TARGET = { width: 1920, height: 1080 }
const DEFAULT_NAME = 'CueDeck Audience GPU'

function envFlag(name: string): boolean { return process.env[name] === '1' }
function nativePath(): string {
  const configured = process.env.CUEDECK_SYPHON_GPU_NATIVE
  if (configured) return isAbsolute(configured) ? configured : resolve(app.getAppPath(), configured)
  return join(app.getAppPath(), 'native', 'syphon-probe', 'build', 'libcuedeck_syphon_gpu.dylib')
}
function numericEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function omtProgramActive(): boolean {
  const omt = store.get().omt
  return omt.outputs.program.state === 'on' || omt.enabled.program
}

export interface GpuAudienceStatus {
  active: boolean
  failed: boolean
  reason: string | null
  target: { width: number; height: number }
  actual: { width: number; height: number } | null
  firstTextureAtMs: number
  missingTexturePaints: number
  windowId: number | null
}

export class GpuAudienceMode {
  private win: BrowserWindow | null = null
  private publisher: GpuTexturePublisher | null = null
  private unsubscribe: (() => void) | null = null
  private disposed = false
  private failed = false
  private reason: string | null = null
  private readonly guard = { stop: (reason: string) => this.stop(reason) }

  start(): { ok: boolean; error?: string } {
    if (this.disposed) return { ok: false, error: 'GPU audience is disposed' }
    if (app.isPackaged || process.platform !== 'darwin') return { ok: false, error: 'dev macOS only' }
    if (process.env.CUEDECK_SYPHON_GPU_AUDIENCE !== '1') return { ok: false, error: 'not enabled' }
    if (process.env.CUEDECK_SYPHON_GPU === '1') return { ok: false, error: 'synthetic probe mode is active' }
    if (process.env.CUEDECK_SYPHON_BRIDGE === '1') return { ok: false, error: 'CPU Syphon bridge is active' }
    const state = store.get()
    if (state.layout !== 'solo') return this.refuse('layout is not solo')
    if (getActiveWindows().get('audience')) return this.refuse('physical audience window exists')
    if (store.registeredWindow('audience')) return this.refuse('audience window already registered')
    if (ghostWindow('audience')) return this.refuse('another hidden audience lease exists')
    if (state.stream.running) return this.refuse('stream is running')
    if (omtProgramActive()) return this.refuse('OMT program output is running')
    if (!existsSync(nativePath())) return this.refuse(`native publisher not found: ${nativePath()}`)

    try {
      const win = acquireGhost('audience', HOLDER, () => createGpuAudienceWindow(TARGET.width, TARGET.height, false), 'gpu-audience')
      this.win = win
      this.publisher = new GpuTexturePublisher(
        {
          nativePath: nativePath(),
          name: (process.env.CUEDECK_SYPHON_GPU_NAME ?? DEFAULT_NAME).slice(0, 128),
          isPublic: envFlag('CUEDECK_SYPHON_GPU_PUBLIC'),
          flipY: envFlag('CUEDECK_SYPHON_GPU_FLIP_Y'),
          timeoutMs: numericEnv('CUEDECK_SYPHON_GPU_TIMEOUT_MS', 5000, 500, 15000),
          firstTextureMs: numericEnv('CUEDECK_SYPHON_GPU_FIRST_TEXTURE_MS', 5000, 1000, 20000),
          targetSize: TARGET,
        },
        () => this.source(),
        (reason) => this.fail(reason),
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
          `actual texture size is logged by the publisher`)
        win.webContents.startPainting()
        win.webContents.invalidate()
      })
      win.webContents.once('did-fail-load', (_e, code, desc) => this.fail(`audience page load: ${code} ${desc}`))
      this.publisher.start()
      if (this.failed || this.disposed) {
        return { ok: false, error: this.reason ?? 'GPU publisher failed' }
      }
      setGpuAudienceGuard(this.guard)
      try { loadGpuAudiencePage(win) } catch (error) {
        this.stop(`load audience page: ${(error as Error).message}`)
        return { ok: false, error: this.reason ?? 'load failed' }
      }
      this.unsubscribe = store.onChange((next) => {
        if (this.disposed) return
        if (next.layout !== 'solo') this.stop('layout changed')
        else if (next.stream.running) this.stop('stream started')
        else if (next.omt.outputs.program.state === 'on' || next.omt.enabled.program) this.stop('OMT program started')
      })
      win.once('closed', () => {
        if (!this.disposed && this.win === win) this.stop('window closed')
      })
      log.info(
        `syphon-gpu-audience: ON, single offscreen audience renderer, target ${TARGET.width}x${TARGET.height} ` +
        `physical, server=${envFlag('CUEDECK_SYPHON_GPU_PUBLIC') ? 'PUBLIC' : 'private'}, ` +
        `flipY=${envFlag('CUEDECK_SYPHON_GPU_FLIP_Y') ? 1 : 0}`,
      )
      return { ok: true }
    } catch (error) {
      return this.refuse(`create: ${(error as Error).message}`)
    }
  }

  stop(reason: string): void {
    if (this.disposed) return
    this.disposed = true
    this.reason = reason
    this.unsubscribe?.()
    this.unsubscribe = null
    clearGpuAudienceGuard(this.guard)
    // Preserve the proven lifetime rule: never release a texture before native
    // completion. The window can be destroyed; one held texture is bounded.
    try { this.publisher?.destroyNow() } catch (error) {
      log.warn(`syphon-gpu-audience: publisher stop: ${(error as Error).message}`)
    }
    this.publisher = null
    try {
      if (this.win && !this.win.isDestroyed()) this.win.destroy()
    } catch (error) {
      log.warn(`syphon-gpu-audience: window destroy: ${(error as Error).message}`)
    }
    this.win = null
    try { releaseGhost('audience', HOLDER) } catch (error) {
      log.warn(`syphon-gpu-audience: ghost release: ${(error as Error).message}`)
    }
    log.info(`syphon-gpu-audience: stopped (${reason})`)
  }

  status(): GpuAudienceStatus {
    const pub = this.publisher?.status()
    return {
      active: !this.disposed && this.publisher !== null,
      failed: this.failed,
      reason: this.reason,
      target: { ...TARGET },
      actual: pub && pub.width > 0 ? { width: pub.width, height: pub.height } : null,
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

  private refuse(reason: string): { ok: false; error: string } {
    this.reason = reason
    log.warn(`syphon-gpu-audience: refused: ${reason}`)
    return { ok: false, error: reason }
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    log.error(`syphon-gpu-audience: failed: ${reason}`)
    // stop() will preserve pending texture and destroy the GPU-only window.
    this.stop(`failure: ${reason}`)
  }
}

let mode: GpuAudienceMode | null = null

export function initSyphonGpuAudience(): void {
  if (mode) return
  if (app.isPackaged || process.platform !== 'darwin') return
  if (process.env.CUEDECK_SYPHON_GPU_AUDIENCE !== '1') return
  mode = new GpuAudienceMode()
  const result = mode.start()
  if (!result.ok) {
    log.warn(`syphon-gpu-audience: not started: ${result.error}`)
  }
}

export function shutdownSyphonGpuAudience(): void {
  mode?.stop('shutdown')
  mode = null
}

export function gpuAudienceStatus(): GpuAudienceStatus | null {
  return mode?.status() ?? null
}

/** Test/other-output hook: stop the experiment before a normal consumer. */
export function stopGpuAudienceForOutput(reason: string): void {
  stopGpuAudienceForNormalOutput(reason)
}
