/**
 * Persisted local GPU output (Syphon / Spout) and its single runtime manager.
 *
 * Kept separate from the GPU producer so the class can be tested without the
 * settings store, and so renderer input never reaches native paths/environment.
 */
import { app } from 'electron'
import log from 'electron-log/main'
import { existsSync } from 'node:fs'
import { localGpuNativePath, macSyphonSupported } from './local-gpu-path.js'
import { store } from './state.js'
import {
  getSyphonSettings,
  hasSyphonSettings,
  setSyphonSettings,
  getSyphonPrompterSettings,
  setSyphonPrompterSettings,
} from './display-mapping.js'
import { GpuPrompterMode } from './syphon-gpu-prompter.js'
import { t } from '../shared/i18n.js'
import {
  GpuAudienceMode,
  type GpuAudienceHooks,
  type GpuAudienceOptions,
  type GpuAudienceStartResult,
  type GpuAudienceStatus,
  type GpuAudienceStopResult,
} from './syphon-gpu-audience.js'
import {
  DEFAULT_SYPHON_SETTINGS,
  SYPHON_NAME_MAX,
  SYPHON_TARGET,
  defaultSyphonStatus,
  type SyphonReason,
  type SyphonRuntimeState,
  type SyphonSettings,
  type SyphonStatus,
} from '../shared/types.js'
import { cleanSyphonName } from '../shared/syphon.js'
import { registerSyphonIpc as registerSettingsIpc } from './syphon-settings-ipc.js'


const DEFAULT_NAME = DEFAULT_SYPHON_SETTINGS.name

function nativePath(): string {
  return localGpuNativePath(process.platform, app.isPackaged, app.getAppPath(), process.resourcesPath, process.env)
}
function numericEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

// ── Runtime manager and persisted settings ──────────────────────────────────

export interface SyphonModeLike {
  start(): GpuAudienceStartResult
  stop(reason: string): Promise<GpuAudienceStopResult>
  status(): Pick<GpuAudienceStatus, 'active' | 'failed' | 'actual' | 'sawTexture'>
  name(): string
}

export interface SyphonManagerDeps {
  platform: NodeJS.Platform
  packaged: boolean
  macosSupported?: boolean
  env: NodeJS.ProcessEnv
  nativePath: string
  nativeExists: (path: string) => boolean
  loadSettings: () => { settings: SyphonSettings; stored: boolean }
  saveSettings: (settings: SyphonSettings) => void
  publish: (status: SyphonStatus) => void
  createMode: (options: GpuAudienceOptions, hooks: GpuAudienceHooks) => SyphonModeLike
  validateSettings?: (settings: SyphonSettings) => string | null
}

function defaultDeps(output: 'audience' | 'prompter' = 'audience'): SyphonManagerDeps {
  const prompter = output === 'prompter'
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    macosSupported: macSyphonSupported(),
    env: process.env,
    nativePath: nativePath(),
    nativeExists: existsSync,
    loadSettings: () => {
      if (prompter) return { settings: getSyphonPrompterSettings(), stored: true }
      const stored = hasSyphonSettings()
      return {
        settings: startupSyphonSettings(
          stored ? getSyphonSettings() : { ...DEFAULT_SYPHON_SETTINGS },
          process.env, app.isPackaged, process.platform),
        stored,
      }
    },
    saveSettings: prompter ? setSyphonPrompterSettings : setSyphonSettings,
    publish: (status) => store.patch(prompter ? { syphonPrompter: status } : { syphon: status }),
    createMode: (options, hooks) => prompter ? new GpuPrompterMode(options, hooks) : new GpuAudienceMode(options, hooks),
    validateSettings: (settings) => {
      const other = (prompter ? manager : prompterManager)?.getStatus()
      return settings.enabled && other?.enabled && settings.name.toLowerCase() === other.name.toLowerCase()
        ? t('Имена источников зала и суфлёра должны различаться') : null
    },
  }
}

/**
 * Old QA starts with CUEDECK_SYPHON_GPU_AUDIENCE=1 and expects the source to be
 * there without touching settings. The env therefore overrides the saved
 * request for that run; without the env the operator's saved choice wins.
 */
export function startupSyphonSettings(
  stored: SyphonSettings,
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  platform: NodeJS.Platform,
): SyphonSettings {
  const enabled = platform === 'win32' ? env.CUEDECK_SPOUT_GPU_AUDIENCE : env.CUEDECK_SYPHON_GPU_AUDIENCE
  if (packaged || !['darwin', 'win32'].includes(platform) || enabled !== '1') return { ...stored }
  return {
    enabled: true,
    name: cleanSyphonName(platform === 'win32' ? env.CUEDECK_SPOUT_GPU_NAME : env.CUEDECK_SYPHON_GPU_NAME,
      stored.name || DEFAULT_NAME),
  }
}

export type SyphonConfigureResult =
  | { ok: true; status: SyphonStatus }
  | { ok: false; error: string; status: SyphonStatus }

/** Strict renderer input: only enabled/name, no paths or env. */
export function sanitizeSyphonPatch(raw: unknown): Partial<SyphonSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings object required')
  const value = raw as Record<string, unknown>
  const patch: Partial<SyphonSettings> = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new Error('Boolean required for enabled')
    patch.enabled = value.enabled
  }
  if (value.name !== undefined) {
    if (typeof value.name !== 'string') throw new Error('String required for name')
    const name = value.name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (!name) throw new Error('Source name must not be empty')
    if (name.length > SYPHON_NAME_MAX) {
      throw new Error(`Source name must be at most ${SYPHON_NAME_MAX} characters`)
    }
    patch.name = name
  }
  if (Object.keys(patch).length === 0) throw new Error('No supported settings')
  return patch
}

export class SyphonGpuManager {
  private settings: SyphonSettings = { ...DEFAULT_SYPHON_SETTINGS }
  private status: SyphonStatus = defaultSyphonStatus()
  private mode: SyphonModeLike | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private initialized = false
  private managerStop = false
  private stopping = false
  private stopGate: Promise<void> = Promise.resolve()
  private resolveStopGate: (() => void) | null = null
  private restartLocked = false
  private lastError: string | null = null

  constructor(private readonly deps: SyphonManagerDeps = defaultDeps()) {}

  /** Stop for app exit without changing the operator's saved enabled flag. */
  async shutdown(): Promise<void> {
    await this.stopMode('shutdown')
    if (!this.restartLocked) this.setState('off')
  }

  getStatus(): SyphonStatus {
    return { ...this.status, target: { ...this.status.target }, actual: this.status.actual ? { ...this.status.actual } : null }
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    const loaded = this.deps.loadSettings()
    this.settings = { ...loaded.settings }
    this.status = { ...defaultSyphonStatus(), ...this.settings }
    const unavailable = this.unavailableReason()
    if (unavailable) {
      this.setState('unavailable', unavailable, this.unavailableDetail(unavailable))
      return
    }
    if (this.settings.enabled) {
      await this.enqueue(() => this.startMode())
    } else {
      this.setState('off')
    }
  }

  async configure(raw: unknown): Promise<SyphonConfigureResult> {
    const patch = sanitizeSyphonPatch(raw)
    if (!this.initialized) await this.init()
    return this.enqueue(() => this.applyConfigure(patch))
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private async applyConfigure(patch: Partial<SyphonSettings>): Promise<SyphonConfigureResult> {
    const next = { ...this.settings, ...patch }
    const invalid = this.deps.validateSettings?.(next)
    if (invalid) return this.failure(invalid)
    this.settings = next
    this.deps.saveSettings(this.settings)
    this.status = { ...this.status, enabled: this.settings.enabled, name: this.settings.name }
    this.publish()

    if (!this.settings.enabled) {
      await this.stopMode('off')
      if (this.restartLocked) return this.failure('stop-timeout')
      this.setState('off')
      return { ok: true, status: this.getStatus() }
    }

    const unavailable = this.unavailableReason()
    if (unavailable) {
      await this.stopMode('unavailable')
      this.setState('unavailable', unavailable, this.unavailableDetail(unavailable))
      return this.failure(unavailable)
    }
    if (this.restartLocked) {
      this.setState('error', 'stop-timeout', this.lastError ?? 'Previous native frame did not complete')
      return this.failure('stop-timeout')
    }
    if (this.stopping) await this.stopGate

    const running = this.mode
    if (running && running.name() === this.settings.name) return { ok: true, status: this.getStatus() }
    if (running) await this.stopMode('restart')
    if (this.restartLocked) return this.failure('stop-timeout')

    // Starting only on an explicit enable or a rename of a running source.
    // A conflict never auto-retries; the operator must toggle off and on.
    if (patch.enabled === true || running) {
      const started = await this.startMode()
      if (!started) return this.failure(this.status.reason ?? 'start-refused')
    }
    return { ok: true, status: this.getStatus() }
  }

  private async startMode(): Promise<boolean> {
    if (this.stopping) await this.stopGate
    if (this.mode) return true
    const invalid = this.deps.validateSettings?.(this.settings)
    if (invalid) {
      this.setState('error', 'runtime', invalid)
      return false
    }
    const unavailable = this.unavailableReason()
    if (unavailable) {
      this.setState('unavailable', unavailable, this.unavailableDetail(unavailable))
      return false
    }
    if (this.restartLocked) {
      this.setState('error', 'stop-timeout', this.lastError ?? 'Previous native frame did not complete')
      return false
    }
    this.setState('starting')
    const mode = this.deps.createMode({
      name: this.settings.name,
      // Spout frames already have the top-left origin. Syphon uses the tested
      // flip; its env overrides remain available for macOS QA.
      isPublic: this.deps.platform === 'win32' || this.deps.env.CUEDECK_SYPHON_GPU_PUBLIC !== '0',
      flipY: this.deps.platform === 'win32' ? false : this.deps.env.CUEDECK_SYPHON_GPU_FLIP_Y !== '0',
      timeoutMs: numericEnv('CUEDECK_SYPHON_GPU_TIMEOUT_MS', 5000, 500, 15000),
      firstTextureMs: numericEnv('CUEDECK_SYPHON_GPU_FIRST_TEXTURE_MS', 5000, 1000, 20000),
      nativePath: this.deps.nativePath,
    }, {
      onFirstTexture: () => this.onFirstTexture(),
      onFatal: (reason) => this.onFatal(reason),
      onStopped: (reason) => this.onModeStopped(reason),
      onStopResult: (reason, result) => this.onModeStopResult(reason, result),
    })
    this.mode = mode
    const result = mode.start()
    if (result.ok) return true
    this.mode = null
    void mode.stop('start-refused')
    const unavailableStates: SyphonReason[] = ['packaged', 'platform', 'macos-version', 'native-missing', 'synthetic', 'cpu-bridge']
    if (result.reason === 'runtime') {
      this.setState('error', 'runtime', result.detail)
    } else {
      this.setState(unavailableStates.includes(result.reason) ? 'unavailable' : 'blocked',
        result.reason, result.detail)
    }
    return false
  }

  private async stopMode(reason: string): Promise<void> {
    const mode = this.mode
    if (!mode) return
    this.mode = null
    this.managerStop = true
    this.stopping = true
    try {
      const result = await mode.stop(reason)
      if (result.timedOut) {
        this.restartLocked = true
        this.lastError = 'Previous native frame did not complete; restart is blocked'
        this.setState('error', 'stop-timeout', this.lastError)
      }
    } catch (error) {
      this.restartLocked = true
      this.lastError = (error as Error).message
      this.setState('error', 'runtime', this.lastError)
    } finally {
      this.managerStop = false
      this.stopping = false
    }
  }

  private onFirstTexture(): void {
    if (!this.mode || this.stopping) return
    const actual = this.mode.status().actual
    this.setState('on', null, null, actual)
  }

  private onFatal(reason: string): void {
    this.lastError = reason
    this.setState('error', 'runtime', reason)
  }

  private onModeStopped(reason: string): void {
    if (this.managerStop) return
    this.mode = null
    this.stopping = true
    if (!this.resolveStopGate) {
      this.stopGate = new Promise<void>((resolve) => { this.resolveStopGate = resolve })
    }
    const conflict = reason.startsWith('conflict:')
      ? reason.slice('conflict:'.length) as SyphonReason
      : reason === 'stream' ? 'stream'
      : reason === 'omt' ? 'omt-program'
      : reason === 'ndi' ? 'ndi-program'
      : reason === 'layout' ? 'layout'
      : reason.startsWith('ghost:') ? 'audience-lease'
      : null
    if (conflict) {
      this.setState('blocked', conflict)
    } else if (reason === 'window-closed' || reason === 'error') {
      this.setState('error', 'runtime', this.lastError)
    } else {
      this.setState('off')
    }
  }

  private onModeStopResult(_reason: string, result: GpuAudienceStopResult): void {
    if (result.timedOut) {
      this.restartLocked = true
      this.lastError = 'Previous native frame did not complete; restart is blocked'
      this.setState('error', 'stop-timeout', this.lastError)
    }
    this.stopping = false
    const resolve = this.resolveStopGate
    this.resolveStopGate = null
    this.stopGate = Promise.resolve()
    resolve?.()
  }

  private unavailableReason(): SyphonReason | null {
    if (!['darwin', 'win32'].includes(this.deps.platform)) return 'platform'
    if (this.deps.platform === 'darwin' && this.deps.macosSupported === false) return 'macos-version'
    if (this.deps.env.CUEDECK_SYPHON_GPU === '1') return 'synthetic'
    if (this.deps.env.CUEDECK_SYPHON_BRIDGE === '1') return 'cpu-bridge'
    if (!this.deps.nativeExists(this.deps.nativePath)) return 'native-missing'
    return null
  }

  private unavailableDetail(reason: SyphonReason): string | null {
    switch (reason) {
      case 'packaged': return 'dev build only; packaged native resource is not ready'
      case 'platform': return 'macOS or Windows only'
      case 'macos-version': return 'Syphon requires macOS 13 or later'
      case 'synthetic': return 'CUEDECK_SYPHON_GPU=1 is active'
      case 'cpu-bridge': return 'CUEDECK_SYPHON_BRIDGE=1 is active'
      case 'native-missing': return `native publisher not found: ${this.deps.nativePath}`
      default: return null
    }
  }

  private setState(state: SyphonRuntimeState, reason: SyphonReason | null = null,
                   detail: string | null = null, actual: { width: number; height: number } | null = null): void {
    this.status = {
      ...this.status,
      enabled: this.settings.enabled,
      name: this.settings.name,
      state,
      reason: state === 'unavailable' || state === 'blocked' || state === 'error' ? reason : null,
      detail: state === 'unavailable' || state === 'error' || state === 'blocked' ? detail : null,
      target: { ...SYPHON_TARGET },
      actual: state === 'on' ? actual : null,
    }
    this.publish()
  }

  private publish(): void {
    this.deps.publish(this.getStatus())
  }

  private failure(error: string): SyphonConfigureResult {
    return { ok: false, error, status: this.getStatus() }
  }
}

let manager: SyphonGpuManager | null = null
let prompterManager: SyphonGpuManager | null = null

function ensureManager(): SyphonGpuManager {
  if (!manager) manager = new SyphonGpuManager()
  return manager
}

function ensurePrompterManager(): SyphonGpuManager {
  if (!prompterManager) prompterManager = new SyphonGpuManager(defaultDeps('prompter'))
  return prompterManager
}

/** Called once after boot layout; reads persisted settings and may start the output. */
export function initSyphonGpuAudience(): void {
  void Promise.all([ensureManager().init(), ensurePrompterManager().init()]).catch((error: unknown) => {
    log.error(`syphon-gpu-audience: init failed: ${(error as Error).message}`)
  })
}

export function registerSyphonIpc(): void {
  registerSettingsIpc(ensureManager())
  registerSettingsIpc(ensurePrompterManager(), 'syphon-prompter')
}

export async function shutdownSyphonGpuAudience(): Promise<void> {
  const current = manager
  const prompter = prompterManager
  manager = null
  prompterManager = null
  await Promise.all([current?.shutdown(), prompter?.shutdown()])
}

export function gpuAudienceStatus(): SyphonStatus | null {
  return manager?.getStatus() ?? null
}
