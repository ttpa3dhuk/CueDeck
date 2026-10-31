import { describe, expect, it, vi } from 'vitest'
import {
  buildFrameProbeArgs,
  FrameTimelineService,
  isPackagedProcess,
  resolveFfprobeCommand,
} from '../src/main/frame-timeline'
import {
  FRAME_WINDOW_BUCKET_SEC,
  FRAME_WINDOW_PAD_SEC,
  frameWindowForPosition,
  parseFrameTimestamps,
  stepFrameTarget,
} from '../src/shared/frame-timeline'
import type { FrameTimelineProbeResult } from '../src/shared/frame-timeline'

const ok = (timestamps: number[]): FrameTimelineProbeResult => ({ ok: true, timeline: { timestamps } })

describe('actual frame timestamps (no fixed FPS)', () => {
  it('parses 23.976 timestamps exactly as reported', () => {
    const output = '0\n0.041708\n0.083417\n0.125125\n'
    const parsed = parseFrameTimestamps(output)
    expect(parsed).toEqual([0, 0.041708, 0.083417, 0.125125])
    expect(stepFrameTarget(parsed, 0.041708, 1)).toBe(0.083417)
    expect(stepFrameTarget(parsed, 0.083417, -1)).toBe(0.041708)
  })

  it('follows variable frame rate gaps instead of assuming 1/25', () => {
    const vfr = parseFrameTimestamps('0\n0.04\n0.05\n0.1\n0.13\n')
    expect(stepFrameTarget(vfr, 0.045, 1)).toBe(0.05)
    expect(stepFrameTarget(vfr, 0.045, -1)).toBe(0)
    expect(vfr[1] - vfr[0]).toBeCloseTo(0.04)
    expect(vfr[3] - vfr[2]).toBeCloseTo(0.05)
  })

  it('accepts labelled rows, ignores N/A and duplicates, sorts B-frame order', () => {
    expect(parseFrameTimestamps('best_effort_timestamp_time=0.2,\nN/A\n0.1\n0.2\n-1\nbad\n'))
      .toEqual([0.1, 0.2])
  })

  it('returns null at both ends and uses the containing frame for backward steps', () => {
    const frames = [0, 0.04, 0.08]
    expect(stepFrameTarget(frames, 0, -1)).toBeNull()
    expect(stepFrameTarget(frames, 0.08, 1)).toBeNull()
    expect(stepFrameTarget([], 0, 1)).toBeNull()
    expect(stepFrameTarget(frames, 0.04, -1)).toBe(0)
    expect(stepFrameTarget(frames, 0.04, 1)).toBe(0.08)
    expect(stepFrameTarget(frames, 0.05, -1)).toBe(0)
    expect(stepFrameTarget(frames, 0.05, 1)).toBe(0.08)
    expect(stepFrameTarget(frames, 0.01, -1)).toBeNull()
    expect(stepFrameTarget(frames, 0.01, 1)).toBe(0.04)
  })

  it('keeps raw PTS coordinates for nonzero stream starts (no start_time subtraction)', () => {
    const offset = parseFrameTimestamps('5.000000,\n5.041708\n5.083417\n')
    expect(offset).toEqual([5, 5.041708, 5.083417])
    expect(stepFrameTarget(offset, 5.05, 1)).toBe(5.083417)
    expect(stepFrameTarget(offset, 5.05, -1)).toBe(5)
  })
})

describe('bounded ffprobe windows for long videos', () => {
  it('queries a small absolute window instead of the whole file', () => {
    const window = frameWindowForPosition(12, 7200)
    expect(window).toEqual({ startSec: 8, endSec: 17 })
    const args = buildFrameProbeArgs('/long.mp4', window)
    expect(args).toContain('-read_intervals')
    expect(args[args.indexOf('-read_intervals') + 1]).toBe('8.000%17.000')
    expect(args).toContain('frame=best_effort_timestamp_time')
    expect(args).not.toContain('packet=pts_time')
    expect(args.join(' ')).not.toContain('+')
    expect(args[args.length - 2]).toBe('-i')
    expect(args[args.length - 1]).toBe('/long.mp4')
  })

  it('stays bounded at the end of a multi-hour file', () => {
    const window = frameWindowForPosition(7200, 7200)
    expect(window).toEqual({ startSec: 7198, endSec: 7200 })
    expect(window.endSec - window.startSec).toBeLessThan(FRAME_WINDOW_BUCKET_SEC + FRAME_WINDOW_PAD_SEC + 1)
  })

  it('passes the window to the probe and caches by that window', async () => {
    const probe = vi.fn(async () => ok([8, 8.04, 8.08]))
    const service = new FrameTimelineService(probe, async () => 'v1')
    await service.get('/long.mp4', 12, 7200)
    expect((probe.mock.calls[0] as unknown[])[2]).toEqual({ window: { startSec: 8, endSec: 17 } })
    await service.get('/long.mp4', 12, 7200)
    expect(probe).toHaveBeenCalledOnce()
  })
})

describe('packaged-process detection', () => {
  it('treats defaultApp false and undefined with resourcesPath as packaged', () => {
    expect(isPackagedProcess({ defaultApp: false, resourcesPath: '/app/Resources' })).toBe(true)
    expect(isPackagedProcess({ defaultApp: undefined, resourcesPath: '/app/Resources' })).toBe(true)
    expect(isPackagedProcess({ defaultApp: true, resourcesPath: '/app/Resources' })).toBe(false)
    expect(isPackagedProcess({ defaultApp: false })).toBe(false)
  })
})

describe('ffprobe discovery', () => {
  it('packaged Mac always resolves the bundled Resources/ffprobe binary', () => {
    const path = resolveFfprobeCommand({
      env: {}, platform: 'darwin', arch: 'arm64', packaged: true,
      resourcesPath: '/Applications/CueDeck.app/Contents/Resources',
      exists: () => false,
    })
    expect(path).toBe('/Applications/CueDeck.app/Contents/Resources/ffprobe/ffprobe')
  })

  it('packaged Windows resolves the matching .exe and never falls back to PATH', () => {
    const path = resolveFfprobeCommand({
      env: {}, platform: 'win32', arch: 'x64', packaged: true,
      resourcesPath: 'C:\\Program Files\\CueDeck\\resources',
      exists: (candidate) => candidate === '/opt/homebrew/bin/ffprobe',
    })
    expect(path.replaceAll('\\', '/')).toBe('C:/Program Files/CueDeck/resources/ffprobe/ffprobe.exe')
    expect(path).not.toContain('/opt/homebrew')
  })

  it('development uses vendor/ffprobe, not PATH, unless explicitly allowed', () => {
    const vendor = resolveFfprobeCommand({
      env: {}, platform: 'darwin', arch: 'arm64', packaged: false, cwd: '/repo',
      exists: (candidate) => candidate === '/repo/vendor/ffprobe/mac-arm64/ffprobe',
    })
    expect(vendor).toBe('/repo/vendor/ffprobe/mac-arm64/ffprobe')
    const missing = resolveFfprobeCommand({
      env: {}, platform: 'darwin', arch: 'arm64', packaged: false, cwd: '/repo',
      exists: (candidate) => candidate === '/opt/homebrew/bin/ffprobe',
    })
    expect(missing).toBe('/repo/vendor/ffprobe/mac-arm64/ffprobe')
    expect(missing).not.toContain('homebrew')
    const optIn = resolveFfprobeCommand({
      env: { CUEDECK_FFPROBE_ALLOW_PATH: '1' }, platform: 'darwin', arch: 'arm64', packaged: false, cwd: '/repo',
      exists: (candidate) => candidate === '/opt/homebrew/bin/ffprobe',
    })
    expect(optIn).toBe('/opt/homebrew/bin/ffprobe')
  })

  it('keeps an explicit env override for development/debugging', () => {
    expect(resolveFfprobeCommand({
      env: { CUEDECK_FFPROBE: '/custom/ffprobe' }, platform: 'darwin', arch: 'arm64', packaged: true,
      resourcesPath: '/app/Resources', exists: () => false,
    })).toBe('/custom/ffprobe')
  })
})

describe('FrameTimelineService cache/cancel', () => {
  it('deduplicates concurrent probes, caches success and invalidates on fingerprint change', async () => {
    let release!: (value: FrameTimelineProbeResult) => void
    const probe = vi.fn(() => new Promise<FrameTimelineProbeResult>((resolve) => { release = resolve }))
    let fingerprint = 'v1'
    const service = new FrameTimelineService(probe, async () => fingerprint, 2)

    const first = service.get('/a.mp4')
    const second = service.get('/a.mp4')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    release(ok([0, 0.04]))
    await expect(first).resolves.toEqual(ok([0, 0.04]))
    await expect(second).resolves.toEqual(ok([0, 0.04]))
    await expect(service.get('/a.mp4')).resolves.toEqual(ok([0, 0.04]))
    expect(probe).toHaveBeenCalledOnce()

    fingerprint = 'v2'
    const third = service.get('/a.mp4')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    release(ok([0, 0.05]))
    await expect(third).resolves.toEqual(ok([0, 0.05]))
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('stops re-spawning when ffprobe is unavailable for this launch', async () => {
    const probe = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const }))
    const service = new FrameTimelineService(probe, async () => 'v1')
    await expect(service.get('/a')).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(service.get('/b')).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('does not re-spawn ffprobe for a window with no decoded frames', async () => {
    const probe = vi.fn(async () => ({ ok: false as const, reason: 'no-video' as const }))
    const service = new FrameTimelineService(probe, async () => 'v1')
    await expect(service.get('/av1.mp4', 12, 30)).resolves.toEqual({ ok: false, reason: 'no-video' })
    await expect(service.get('/av1.mp4', 12, 30)).resolves.toEqual({ ok: false, reason: 'no-video' })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('aborts an in-flight probe on cancel', async () => {
    const probe = vi.fn((_path: string, signal: AbortSignal) => new Promise<FrameTimelineProbeResult>((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }), { once: true })
    }))
    const service = new FrameTimelineService(probe, async () => 'v1')
    const result = service.get('/cancel.mp4')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    service.cancel('/cancel.mp4')
    await expect(result).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(probe.mock.calls[0][1].aborted).toBe(true)
  })

  it('evicts the least recently used cached file', async () => {
    const probe = vi.fn(async (path: string) => ok([0, path.length]))
    let fingerprint = 'v1'
    const service = new FrameTimelineService(probe, async () => fingerprint, 1)
    await service.get('/a')
    await service.get('/a')
    fingerprint = 'v2'
    await service.get('/a')
    fingerprint = 'v3'
    await service.get('/b')
    fingerprint = 'v1'
    await service.get('/a')
    expect(probe).toHaveBeenCalledTimes(4)
    expect(service.size).toBe(1)
  })
})
