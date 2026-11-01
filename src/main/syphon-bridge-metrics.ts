/**
 * Dev-only metrics for the CPU Syphon bridge. It is inert unless the bridge
 * dev opt-in starts it. The optional NDJSON file is consumed by
 * native/syphon-probe/measure-bridge.mjs.
 *
 * Counters describe work actually attempted; no values are estimates. In
 * particular `droppedBusy` is counted before NativeImage.toBitmap(), so a
 * frame counted there did not pay the CPU readback cost.
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

const SAMPLES = 300

interface Counters {
  captured: number
  sent: number
  published: number
  droppedBusy: number
  droppedNoHelper: number
  invalidFrame: number
  timeouts: number
  helperRestarts: number
  helperFailures: number
  writeErrors: number
}

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

export class SyphonBridgeMetrics {
  private readonly counters: Counters = {
    captured: 0,
    sent: 0,
    published: 0,
    droppedBusy: 0,
    droppedNoHelper: 0,
    invalidFrame: 0,
    timeouts: 0,
    helperRestarts: 0,
    helperFailures: 0,
    writeErrors: 0,
  }
  private readonly callbackMs: number[] = []
  private readonly resizeMs: number[] = []
  private readonly readbackMs: number[] = []
  private readonly ackMs: number[] = []
  private readonly loopDelay: IntervalHistogram
  private timer: NodeJS.Timeout | null = null
  private stream: WriteStream | null = null
  private helperPid: number | null = null
  private width = 0
  private height = 0
  private helperReady = false
  private lastCaptured = 0
  private lastPublished = 0
  private lastCpu = process.cpuUsage()
  private lastTick = Date.now()

  constructor() {
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 })
    this.loopDelay.enable()
  }

  start(): void {
    const path = process.env.CUEDECK_SYPHON_BRIDGE_METRICS
    if (path) {
      try {
        this.stream = createWriteStream(path, { flags: 'a' })
        this.stream.on('error', () => { this.stream = null })
      } catch {
        this.stream = null
      }
    }
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.loopDelay.disable()
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
  }

  setHelperPid(pid: number | null): void {
    this.helperPid = pid
  }

  setSize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  setReady(ready: boolean): void {
    this.helperReady = ready
  }

  inc(key: keyof Counters): void {
    this.counters[key]++
  }

  recordCallback(ms: number): void {
    this.callbackMs.push(ms)
    if (this.callbackMs.length > SAMPLES) this.callbackMs.shift()
  }

  recordResize(ms: number): void {
    this.resizeMs.push(ms)
    if (this.resizeMs.length > SAMPLES) this.resizeMs.shift()
  }

  recordReadback(ms: number): void {
    this.readbackMs.push(ms)
    if (this.readbackMs.length > SAMPLES) this.readbackMs.shift()
  }

  recordAck(ms: number): void {
    this.ackMs.push(ms)
    if (this.ackMs.length > SAMPLES) this.ackMs.shift()
  }

  snapshot(): Record<string, unknown> {
    return {
      ...this.counters,
      width: this.width,
      height: this.height,
      helperPid: this.helperPid,
      helperReady: this.helperReady,
      callbackMs: {
        p95: p95(this.callbackMs),
        max: this.callbackMs.length ? Math.max(...this.callbackMs) : 0,
      },
      resizeMs: {
        p95: p95(this.resizeMs),
        max: this.resizeMs.length ? Math.max(...this.resizeMs) : 0,
      },
      readbackMs: {
        p95: p95(this.readbackMs),
        max: this.readbackMs.length ? Math.max(...this.readbackMs) : 0,
      },
      ackMs: {
        p95: p95(this.ackMs),
        max: this.ackMs.length ? Math.max(...this.ackMs) : 0,
      },
      mainEventLoopMs: {
        p95: this.loopDelay.percentile(95) / 1e6,
        max: this.loopDelay.max / 1e6,
      },
    }
  }

  private tick(): void {
    const now = Date.now()
    const elapsedMs = Math.max(1, now - this.lastTick)
    const captured = this.counters.captured
    const published = this.counters.published
    const captureFps = (captured - this.lastCaptured) * 1000 / elapsedMs
    const publishedFps = (published - this.lastPublished) * 1000 / elapsedMs
    const cpu = process.cpuUsage()
    const cpuPct = ((cpu.user - this.lastCpu.user) + (cpu.system - this.lastCpu.system)) / 1000 / elapsedMs * 100

    this.lastCaptured = captured
    this.lastPublished = published
    this.lastCpu = cpu
    this.lastTick = now

    const line = {
      t: new Date(now).toISOString(),
      kind: 'cuedeck-syphon-cpu-bridge',
      ...this.snapshot(),
      fps: {
        captured: captureFps,
        published: publishedFps,
      },
      mainRssBytes: process.memoryUsage().rss,
      mainCpuPct: cpuPct,
    }
    if (this.stream) {
      try {
        this.stream.write(`${JSON.stringify(line)}\n`)
      } catch {
        this.stream = null
      }
    }
    this.loopDelay.reset()
  }
}
