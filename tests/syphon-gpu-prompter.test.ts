import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ win: null as any, publisher: null as any,
  load: vi.fn(), start: vi.fn(), stop: vi.fn(), fatal: null as any, first: null as any }))
vi.mock('../src/main/windows.js', () => ({ createGpuPrompterWindow: () => mock.win,
  loadGpuPrompterPage: (win: unknown) => mock.load(win) }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../src/main/syphon-gpu-publisher.js', () => ({ GpuTexturePublisher: class {
  start = mock.start
  stopAndWait = mock.stop
  onPaint = vi.fn()
  status = () => ({ width: 1920, height: 1080, sawTexture: true })
  constructor(readonly options: unknown, _source: unknown, fatal: unknown, first: unknown) {
    mock.publisher = this;mock.fatal = fatal;mock.first = first
  }
} }))

import { GpuPrompterMode } from '../src/main/syphon-gpu-prompter'
const options = { name: 'Prompter', nativePath: 'spout.dll', isPublic: true, flipY: false,
  timeoutMs: 5000, firstTextureMs: 5000 }

beforeEach(() => {
  vi.clearAllMocks()
  const wc = Object.assign(new EventEmitter(), { setAudioMuted: vi.fn(), startPainting: vi.fn(), invalidate: vi.fn() })
  mock.win = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => false, destroy: vi.fn() })
  mock.stop.mockResolvedValue({ released: true, timedOut: false })
})

it('starts the native publisher before loading the muted real speaker page', () => {
  const first = vi.fn(),mode = new GpuPrompterMode(options, { onFirstTexture: first })
  expect(mode.start()).toEqual({ ok: true })
  expect(mock.win.webContents.setAudioMuted).toHaveBeenCalledWith(true)
  expect(mock.publisher.options.targetSize).toEqual({ width: 1920, height: 1080 })
  expect(mock.start.mock.invocationCallOrder[0]).toBeLessThan(mock.load.mock.invocationCallOrder[0])
  mock.win.webContents.emit('did-finish-load')
  expect(mock.win.webContents.startPainting).toHaveBeenCalledOnce()
  mock.first();expect(first).toHaveBeenCalledOnce()
})

it('waits for native completion on stop and shares a single stop result', async () => {
  let complete!: (value: { released: boolean; timedOut: boolean }) => void
  mock.stop.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const stopped = vi.fn(),result = vi.fn(),mode = new GpuPrompterMode(options, { onStopped: stopped, onStopResult: result })
  mode.start()
  const pending = mode.stop('off')
  expect(mode.stop('off')).toBe(pending)
  expect(mock.win.destroy).toHaveBeenCalledOnce()
  expect(stopped).toHaveBeenCalledWith('off')
  expect(result).not.toHaveBeenCalled()
  const texture = { release: vi.fn() };mock.win.webContents.emit('paint', { texture })
  expect(texture.release).toHaveBeenCalledOnce()
  complete({ released: false, timedOut: true })
  await expect(pending).resolves.toEqual({ released: false, timedOut: true })
  expect(result).toHaveBeenCalledWith('off', { released: false, timedOut: true })
  expect(mock.stop).toHaveBeenCalledExactlyOnceWith(2000)
})

it('stops on a GPU error without reporting a successful source', async () => {
  const fatal = vi.fn(),stopped = vi.fn(),mode = new GpuPrompterMode(options, { onFatal: fatal, onStopped: stopped })
  mode.start();mock.fatal('device error');mock.fatal('duplicate error')
  expect(fatal).toHaveBeenCalledExactlyOnceWith('device error')
  expect(stopped).toHaveBeenCalledWith('error')
  expect(mode.status()).toMatchObject({ active: false, failed: true })
  expect(mock.win.destroy).toHaveBeenCalledOnce()
  await mode.stop('off')
})
