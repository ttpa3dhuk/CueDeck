import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  frameWindowForPosition,
  parseFrameTimestamps,
  type FrameTimeline,
  type FrameTimelineProbeResult,
  type FrameWindow,
} from '../shared/frame-timeline.js'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_FRAMES = 2_000_000
const FFPROBE_ARGS = [
  '-v', 'error',
  '-select_streams', 'v:0',
  // Decoded frame presentation timestamps. Windowed reads keep this bounded;
  // packet PTS was rejected for exact stepping because a packet is not always
  // one displayed frame. Codecs without a working software decoder (AV1 here)
  // fail closed with no frames instead of substituting packet granularity.
  '-show_entries', 'frame=best_effort_timestamp_time',
  '-of', 'csv=p=0',
]

export interface FfprobeResolveOptions {
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  packaged?: boolean
  cwd?: string
  /** Explicit development opt-in to PATH/Homebrew discovery. */
  allowPath?: boolean
  exists?: (path: string) => boolean
}

const exeFor = (platform: NodeJS.Platform): string => platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

export function bundledFfprobePath(resourcesPath: string, platform: NodeJS.Platform): string {
  return join(resourcesPath, 'ffprobe', exeFor(platform))
}

export function vendorFfprobePath(cwd: string, platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  return join(cwd, 'vendor', 'ffprobe', `${os}-${arch}`, exeFor(platform))
}

export function isPackagedProcess(
  p: { defaultApp?: boolean; resourcesPath?: string } = process as NodeJS.Process & {
    defaultApp?: boolean
    resourcesPath?: string
  },
): boolean {
  // Packaged Electron may expose defaultApp as false or leave it undefined;
  // only the explicit dev value true means "run from node_modules/electron".
  return Boolean(p.resourcesPath) && p.defaultApp !== true
}

function pathDiscovery(platform: NodeJS.Platform, exists: (path: string) => boolean): string {
  const exe = exeFor(platform)
  const common = platform === 'darwin'
    ? ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']
    : platform === 'win32'
      ? []
      : ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe']
  return common.find((candidate) => exists(candidate)) ?? exe
}

/**
 * Resolve the ffprobe used by frame stepping. A packaged app always uses the
 * matching binary shipped under `process.resourcesPath/ffprobe`; there is no
 * PATH fallback in production. Development uses the worktree `vendor/ffprobe`
 * build. PATH/Homebrew is available only with an explicit
 * `CUEDECK_FFPROBE_ALLOW_PATH=1` (or `allowPath`) development opt-in.
 *
 * No binary is bundled by this source tree; `scripts/prepare-ffprobe.cjs`
 * supplies the LGPL build and the packaging commands verify it.
 */
export function resolveFfprobeCommand(options: FfprobeResolveOptions = {}): string {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const resources = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const cwd = options.cwd ?? process.cwd()
  const packaged = options.packaged ?? isPackagedProcess()
  const exists = options.exists ?? existsSync
  const configured = env.CUEDECK_FFPROBE?.trim()
  if (configured) return configured

  // Explicit development override for packagers/debuggers using a system probe.
  if (!packaged && (options.allowPath === true || env.CUEDECK_FFPROBE_ALLOW_PATH === '1')) {
    const discovered = pathDiscovery(platform, exists)
    if (exists(discovered) || discovered === exeFor(platform)) return discovered
  }

  if (packaged) {
    return resources ? bundledFfprobePath(resources, platform) : vendorFfprobePath(cwd, platform, arch)
  }
  return vendorFfprobePath(cwd, platform, arch)
}

let resolvedFfprobe: string | null = null
function ffprobeCommand(): string {
  if (!resolvedFfprobe) resolvedFfprobe = resolveFfprobeCommand()
  return resolvedFfprobe
}

/**
 * Read actual frame presentation timestamps with ffprobe. The child is killed
 * on timeout/abort/output overflow; callers get a typed failure and the UI can
 * say honestly that frame stepping is unavailable instead of faking 1/25 s.
 */
export function buildFrameProbeArgs(path: string, window?: FrameWindow): string[] {
  const args = [...FFPROBE_ARGS]
  if (window) {
    // Absolute end, never `+duration`: `-read_intervals` seeks to the keyframe
    // before start and `+duration` would end earlier than the target.
    args.push('-read_intervals', `${window.startSec.toFixed(3)}%${window.endSec.toFixed(3)}`)
  }
  args.push('-i', path)
  return args
}

export function probeFrameTimeline(
  path: string,
  signal?: AbortSignal,
  options: { timeoutMs?: number; maxOutputBytes?: number; maxFrames?: number; window?: FrameWindow } = {},
): Promise<FrameTimelineProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES
  if (!path) return Promise.resolve({ ok: false, reason: 'no-video' })
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' })

  return new Promise((resolve) => {
    let settled = false
    let chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let timedOut = false
    let aborted = false
    let tooLarge = false
    let child: ReturnType<typeof spawn>

    const finish = (result: FrameTimelineProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const kill = (): void => {
      try { child?.kill('SIGKILL') } catch { /* already gone */ }
    }
    const onAbort = (): void => {
      aborted = true
      kill()
      finish({ ok: false, reason: 'cancelled' })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      finish({ ok: false, reason: 'timeout' })
    }, Math.max(1, timeoutMs))
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      child = spawn(ffprobeCommand(), buildFrameProbeArgs(path, options.window), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, reason: 'failed', message: (error as Error).message })
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) {
        tooLarge = true
        kill()
        return
      }
      chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: error.code === 'ENOENT' ? 'unavailable' : 'failed',
        message: error.message,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      if (aborted) { finish({ ok: false, reason: 'cancelled' }); return }
      if (timedOut) { finish({ ok: false, reason: 'timeout' }); return }
      if (tooLarge) { finish({ ok: false, reason: 'too-large' }); return }
      if (code !== 0) {
        finish({ ok: false, reason: 'failed', message: stderr.trim().slice(0, 500) || `ffprobe exited ${code}` })
        return
      }
      const timestamps = parseFrameTimestamps(Buffer.concat(chunks).toString('utf8'))
      chunks = []
      if (timestamps.length === 0) {
        finish({ ok: false, reason: 'no-video' })
        return
      }
      if (timestamps.length > maxFrames) {
        finish({ ok: false, reason: 'too-large' })
        return
      }
      finish({ ok: true, timeline: options.window ? { timestamps, window: options.window } : { timestamps } })
    })
  })
}

/** Cache invalidation key: same path, same size/mtime = same frame map. */
export async function fileFingerprint(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return 'missing'
  }
}

interface InflightProbe {
  promise: Promise<FrameTimelineProbeResult>
  controller: AbortController
}

function windowKey(window?: FrameWindow): string {
  return window ? `${window.startSec.toFixed(3)}-${window.endSec.toFixed(3)}` : 'full'
}

/**
 * Async bounded cache around ffprobe. Concurrent requests for the same file
 * share one child process; `cancel(path)` aborts it (used when the deck leaves
 * the video). Only successful maps are cached, at most `maxEntries` files.
 */
export class FrameTimelineService {
  private cache = new Map<string, FrameTimeline>()
  private inflight = new Map<string, InflightProbe>()
  private failures = new Map<string, { result: FrameTimelineProbeResult; until: number }>()
  private unavailable = false

  constructor(
    private readonly probe: (
      path: string,
      signal: AbortSignal,
      options?: { window?: FrameWindow },
    ) => Promise<FrameTimelineProbeResult> = probeFrameTimeline,
    private readonly fingerprint: (path: string) => Promise<string> = fileFingerprint,
    private readonly maxEntries = 16,
  ) {}

  async get(path: string, positionSec?: number, durationSec = 0): Promise<FrameTimelineProbeResult> {
    const window = typeof positionSec === 'number' && Number.isFinite(positionSec)
      ? frameWindowForPosition(positionSec, durationSec)
      : undefined
    return this.load(path, window)
  }

  /** Explicit neighbor window, used when a one-frame step crosses a scanned chunk. */
  async getWindow(path: string, window: FrameWindow): Promise<FrameTimelineProbeResult> {
    return this.load(path, window)
  }

  private async load(path: string, window?: FrameWindow): Promise<FrameTimelineProbeResult> {
    // ffprobe is resolved once per launch; don't spawn a doomed child on every
    // arrow press. Installing ffmpeg later takes a restart (like other tools).
    if (this.unavailable) return { ok: false, reason: 'unavailable' }
    const fingerprint = await this.fingerprint(path)
    const key = `${path}\0${fingerprint}\0${windowKey(window)}`
    const failed = this.failures.get(key)
    if (failed) {
      if (failed.until > Date.now()) return failed.result
      this.failures.delete(key)
    }
    const hit = this.cache.get(key)
    if (hit) {
      // LRU: refresh insertion order on use.
      this.cache.delete(key)
      this.cache.set(key, hit)
      return { ok: true, timeline: hit }
    }

    const existing = this.inflight.get(key)
    if (existing) return existing.promise

    const controller = new AbortController()
    let promise: Promise<FrameTimelineProbeResult>
    promise = this.probe(path, controller.signal, window ? { window } : undefined)
      .then((result) => {
        if (result.ok) {
          this.failures.delete(key)
          this.cache.set(key, result.timeline)
          while (this.cache.size > this.maxEntries) {
            const oldest = this.cache.keys().next().value
            if (oldest === undefined) break
            this.cache.delete(oldest)
          }
        } else if (result.reason === 'unavailable') {
          this.unavailable = true
        } else if (result.reason !== 'cancelled') {
          // Labels poll several times per second; a codec with no decoded
          // frames must not spawn ffprobe every tick. Retry transient failures
          // later, no-video less often.
          const ttl = result.reason === 'no-video' ? 60_000 : 5_000
          this.failures.set(key, { result, until: Date.now() + ttl })
          while (this.failures.size > 32) {
            const oldest = this.failures.keys().next().value
            if (oldest === undefined) break
            this.failures.delete(oldest)
          }
        }
        return result
      })
      .finally(() => {
        if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key)
      })
    this.inflight.set(key, { promise, controller })
    return promise
  }

  /** Abort an in-flight probe for this path; cached maps stay usable. */
  cancel(path: string): void {
    for (const [key, job] of this.inflight) {
      if (key.startsWith(`${path}\0`)) job.controller.abort()
    }
  }

  /** Test/debug visibility; production code should only call get/cancel. */
  get size(): number {
    return this.cache.size
  }
}

export const frameTimelines = new FrameTimelineService()
