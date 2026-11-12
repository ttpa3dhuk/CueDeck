import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  screen: { getAllDisplays: () => [] },
}))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/state.js', () => ({ store: { get: () => ({}), patch: vi.fn() } }))
vi.mock('../src/main/display-mapping.js', () => ({
  getSyphonSettings: () => ({ enabled: false, name: 'CueDeck Audience' }),
  hasSyphonSettings: () => true,
  setSyphonSettings: vi.fn(),
}))
vi.mock('../src/main/syphon-gpu-audience.js', () => ({ GpuAudienceMode: class {} }))
vi.mock('../src/main/syphon-settings-ipc.js', () => ({ registerSyphonIpc: vi.fn() }))

import {
  SyphonGpuManager,
  sanitizeSyphonPatch,
  startupSyphonSettings,
  type SyphonManagerDeps,
} from '../src/main/syphon-settings'
import type { GpuAudienceHooks, GpuAudienceOptions } from '../src/main/syphon-gpu-audience'

class FakeMode {
  stopped = 0
  started = false
  sawTexture = false
  actual: { width: number; height: number } | null = null
  stopResult = { released: true, timedOut: false }

  constructor(
    readonly options: GpuAudienceOptions,
    readonly hooks: GpuAudienceHooks,
  ) {}

  start(): { ok: true } { this.started = true; return { ok: true } }
  async stop(reason: string) {
    this.stopped++
    this.hooks.onStopped?.(reason)
    this.hooks.onStopResult?.(reason, this.stopResult)
    return this.stopResult
  }
  status() {
    return { active: this.started, failed: false, actual: this.actual, sawTexture: this.sawTexture }
  }
  name(): string { return this.options.name }
  first(): void {
    this.sawTexture = true
    this.actual = { width: 1920, height: 1080 }
    this.hooks.onFirstTexture?.()
  }
  conflict(reason: string): void {
    this.hooks.onStopped?.(`conflict:${reason}`)
    this.hooks.onStopResult?.(`conflict:${reason}`, { released: true, timedOut: false })
  }
}

function makeDeps(overrides: Partial<SyphonManagerDeps> = {}): {
  deps: SyphonManagerDeps
  created: FakeMode[]
} {
  const created: FakeMode[] = []
  const deps: SyphonManagerDeps = {
    platform: 'darwin',
    packaged: false,
    env: {},
    nativePath: '/tmp/libcuedeck_syphon_gpu.dylib',
    nativeExists: () => true,
    loadSettings: () => ({
      settings: { enabled: false, name: 'CueDeck Audience' },
      stored: true,
    }),
    saveSettings: vi.fn(),
    publish: vi.fn(),
    createMode: (options, hooks) => {
      const mode = new FakeMode(options, hooks)
      created.push(mode)
      return mode
    },
    ...overrides,
  }
  return { deps, created }
}

beforeEach(() => vi.clearAllMocks())

it('keeps two publishers independent through rename, stop and timeout', async () => {
  const hall = makeDeps(), prompter = makeDeps({
    loadSettings: () => ({ settings: { enabled: false, name: 'CueDeck Prompter' }, stored: true }),
  })
  const hallManager = new SyphonGpuManager(hall.deps), prompterManager = new SyphonGpuManager(prompter.deps)
  await hallManager.configure({ enabled: true })
  await prompterManager.configure({ enabled: true })
  hall.created[0].first();prompter.created[0].first()
  await prompterManager.configure({ name: 'Prompter renamed' })
  expect(hall.created[0].stopped).toBe(0)
  expect(hallManager.getStatus().state).toBe('on')
  expect(prompter.created[0].stopped).toBe(1)
  prompter.created[1].stopResult = { released: false, timedOut: true }
  await prompterManager.configure({ enabled: false })
  expect(prompterManager.getStatus().reason).toBe('stop-timeout')
  await hallManager.configure({ enabled: false })
  await hallManager.configure({ enabled: true })
  expect(hall.created).toHaveLength(2)
})

it('rejects conflicting source settings without saving or restarting', async () => {
  const { deps, created } = makeDeps({ validateSettings: s => s.name === 'Reserved' ? 'Duplicate source' : null })
  const manager = new SyphonGpuManager(deps)
  await manager.configure({ enabled: true })
  created[0].first()
  vi.mocked(deps.saveSettings).mockClear()
  const result = await manager.configure({ name: 'Reserved' })
  expect(result).toMatchObject({ ok: false, error: 'Duplicate source' })
  expect(created[0].stopped).toBe(0)
  expect(deps.saveSettings).not.toHaveBeenCalled()
  expect(manager.getStatus().name).toBe('CueDeck Audience')
})

describe('Syphon settings input', () => {
  it('keeps the old QA env starting the source, but only in a dev macOS run', () => {
    const stored = { enabled: false, name: 'Operator name' }
    expect(startupSyphonSettings(stored, {}, false, 'darwin')).toEqual(stored)
    expect(startupSyphonSettings(stored, { CUEDECK_SYPHON_GPU_AUDIENCE: '1' }, false, 'darwin'))
      .toEqual({ enabled: true, name: 'Operator name' })
    expect(startupSyphonSettings(stored, {
      CUEDECK_SYPHON_GPU_AUDIENCE: '1', CUEDECK_SYPHON_GPU_NAME: 'CueDeck Audience GPU',
    }, false, 'darwin')).toEqual({ enabled: true, name: 'CueDeck Audience GPU' })
    expect(startupSyphonSettings(stored, { CUEDECK_SYPHON_GPU_AUDIENCE: '1' }, true, 'darwin'))
      .toEqual(stored)
    expect(startupSyphonSettings(stored, { CUEDECK_SYPHON_GPU_AUDIENCE: '1' }, false, 'win32'))
      .toEqual(stored)
  })

  it('accepts only a boolean enabled and a bounded name, never native paths', () => {
    expect(sanitizeSyphonPatch({ enabled: true, name: '  Hall  ', nativePath: '/tmp/evil.dylib' }))
      .toEqual({ enabled: true, name: 'Hall' })
    expect(() => sanitizeSyphonPatch({ enabled: 'yes' })).toThrow('Boolean')
    expect(() => sanitizeSyphonPatch({ name: '   ' })).toThrow('empty')
    expect(() => sanitizeSyphonPatch({ name: 'x'.repeat(65) })).toThrow('64')
    expect(() => sanitizeSyphonPatch(null)).toThrow('object')
  })
})

describe('Syphon runtime manager', () => {
  it('starts, stops and re-enables with a new producer without losing the saved setting', async () => {
    const { deps, created } = makeDeps()
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    expect(manager.getStatus()).toMatchObject({ state: 'off', enabled: false, name: 'CueDeck Audience' })

    expect(await manager.configure({ enabled: true })).toMatchObject({ ok: true })
    expect(manager.getStatus().state).toBe('starting')
    created[0].first()
    expect(manager.getStatus()).toMatchObject({
      state: 'on', enabled: true, actual: { width: 1920, height: 1080 },
    })

    expect(await manager.configure({ enabled: false })).toMatchObject({ ok: true })
    expect(manager.getStatus().state).toBe('off')
    expect(created[0].stopped).toBe(1)

    expect(await manager.configure({ enabled: true })).toMatchObject({ ok: true })
    expect(created).toHaveLength(2)
    created[1].first()
    expect(manager.getStatus().state).toBe('on')
    expect(deps.saveSettings).toHaveBeenLastCalledWith({ enabled: true, name: 'CueDeck Audience' })
  })

  it('defaults the producer to public and flipped, with explicit zero env as a QA override', async () => {
    const defaults = makeDeps()
    const defaultManager = new SyphonGpuManager(defaults.deps)
    await defaultManager.init()
    await defaultManager.configure({ enabled: true })
    expect(defaults.created[0].options).toMatchObject({ isPublic: true, flipY: true })

    const qa = makeDeps({
      env: { CUEDECK_SYPHON_GPU_PUBLIC: '0', CUEDECK_SYPHON_GPU_FLIP_Y: '0' },
    })
    const qaManager = new SyphonGpuManager(qa.deps)
    await qaManager.init()
    await qaManager.configure({ enabled: true })
    expect(qa.created[0].options).toMatchObject({ isPublic: false, flipY: false })
  })

  it('leaves requested enabled true while blocked, never auto-retries, and re-enables explicitly', async () => {
    const { deps, created } = makeDeps()
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    await manager.configure({ enabled: true })
    created[0].first()

    created[0].conflict('stream')
    expect(manager.getStatus()).toMatchObject({
      state: 'blocked', reason: 'stream', enabled: true, actual: null,
    })
    expect(created).toHaveLength(1)

    await manager.configure({ enabled: false })
    expect(manager.getStatus().state).toBe('off')
    await manager.configure({ enabled: true })
    expect(created).toHaveLength(2)
    expect(manager.getStatus().state).toBe('starting')
  })

  it('restarts the source when the name changes and reports the new running name', async () => {
    const { deps, created } = makeDeps()
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    await manager.configure({ enabled: true })
    created[0].first()

    expect(await manager.configure({ name: 'Main Hall' })).toMatchObject({ ok: true })
    expect(created[0].stopped).toBe(1)
    expect(created[1].options.name).toBe('Main Hall')
    created[1].first()
    expect(manager.getStatus()).toMatchObject({ state: 'on', name: 'Main Hall' })
  })

  it('locks restarts after a bounded stop timeout instead of accumulating held textures', async () => {
    const { deps, created } = makeDeps()
    const original = deps.createMode
    deps.createMode = (options, hooks) => {
      const mode = original(options, hooks) as FakeMode
      mode.stopResult = { released: false, timedOut: true }
      return mode
    }
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    await manager.configure({ enabled: true })
    created[0].first()

    const off = await manager.configure({ enabled: false })
    expect(off.ok).toBe(false)
    expect(manager.getStatus()).toMatchObject({ state: 'error', reason: 'stop-timeout', enabled: false })

    const retry = await manager.configure({ enabled: true })
    expect(retry.ok).toBe(false)
    expect(created).toHaveLength(1)
    expect(manager.getStatus().reason).toBe('stop-timeout')
  })

  it('reports missing packaged native resources as unavailable and never creates a producer', async () => {
    const { deps, created } = makeDeps({ packaged: true, nativeExists: () => false })
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    expect(manager.getStatus()).toMatchObject({ state: 'unavailable', reason: 'native-missing' })

    const result = await manager.configure({ enabled: true })
    expect(result.ok).toBe(false)
    expect(manager.getStatus()).toMatchObject({
      state: 'unavailable', reason: 'native-missing', enabled: true,
    })
    expect(created).toHaveLength(0)
  })

  it('allows a packaged Mac producer with its bundled library on supported macOS', async () => {
    const { deps, created } = makeDeps({ packaged: true, macosSupported: true })
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    expect(await manager.configure({ enabled: true })).toMatchObject({ ok: true })
    created[0].first()
    expect(manager.getStatus().state).toBe('on')
  })

  it('blocks only the native feature on older macOS, before opening a producer', async () => {
    const { deps, created } = makeDeps({ packaged: true, macosSupported: false })
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    expect(manager.getStatus()).toMatchObject({ state: 'unavailable', reason: 'macos-version' })
    expect(created).toHaveLength(0)
  })

  it('uses the same bounded producer lifecycle on Windows, without the macOS Y flip', async () => {
    const { deps, created } = makeDeps({
      platform: 'win32', packaged: true,
      env: { CUEDECK_SYPHON_GPU_PUBLIC: '0', CUEDECK_SYPHON_GPU_FLIP_Y: '1' },
    })
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    expect(manager.getStatus().state).toBe('off')
    await manager.configure({ enabled: true })
    expect(created[0].options).toMatchObject({ isPublic: true, flipY: false })
    created[0].first()
    expect(manager.getStatus().state).toBe('on')
    await manager.configure({ enabled: false })
    expect(created[0].stopped).toBe(1)
  })

  it('reports a missing Windows native module before creating any producer', async () => {
    const { deps, created } = makeDeps({ platform: 'win32', nativeExists: () => false })
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    expect(manager.getStatus()).toMatchObject({ state: 'unavailable', reason: 'native-missing' })
    expect(created).toHaveLength(0)
  })

  it('reports unsupported platforms as unavailable', async () => {
    const { deps, created } = makeDeps({ platform: 'linux' })
    const manager = new SyphonGpuManager(deps)
    await manager.init()
    expect(manager.getStatus()).toMatchObject({ state: 'unavailable', reason: 'platform' })
    expect(created).toHaveLength(0)
  })
})
