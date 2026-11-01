/** Dev-only metrics for the experimental offscreen GPU probe. */
import { createWriteStream, type WriteStream } from 'node:fs'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

const SAMPLES = 300

function p95(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

export class SyphonGpuMetrics {
  private readonly counters = {
    paints: 0, submitted: 0, published: 0, released: 0,
    droppedBusy: 0, droppedNotReady: 0, invalidTexture: 0,
    missingTexturePaints: 0, firstTextureAtMs: 0,
    timeouts: 0, helperRestarts: 0, errors: 0,
  }
  private readonly ackMs: number[] = []
  private readonly submitMs: number[] = []
  private readonly callbackMs: number[] = []
  private readonly loop: IntervalHistogram
  private timer: NodeJS.Timeout | null = null
  private stream: WriteStream | null = null
  private helperPid: number | null = null
  private width = 0
  private height = 0
  private targetWidth = 0
  private targetHeight = 0
  private ready = false
  private lastPublished = 0
  private lastAt = Date.now()
  private lastCpu = process.cpuUsage()

  constructor() {
    this.loop = monitorEventLoopDelay({ resolution: 20 })
    this.loop.enable()
  }

  start(): void {
    const path = process.env.CUEDECK_SYPHON_GPU_METRICS
    if (path) {
      try {
        this.stream = createWriteStream(path, { flags: 'a' })
        this.stream.on('error', () => { this.stream = null })
      } catch { this.stream = null }
    }
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.loop.disable()
    if (this.stream) { this.stream.end(); this.stream = null }
  }

  inc(key: keyof typeof this.counters): void { this.counters[key]++ }
  setHelperPid(pid: number | null): void { this.helperPid = pid }
  setReady(ready: boolean): void { this.ready = ready }
  markFirstTexture(elapsedMs: number): void { this.counters.firstTextureAtMs = Math.max(0, Math.round(elapsedMs)) }
  setTargetSize(width: number, height: number): void { this.targetWidth = width; this.targetHeight = height }
  setSize(width: number, height: number): void { this.width = width; this.height = height }
  recordSubmit(ms: number): void { this.submitMs.push(ms); if (this.submitMs.length > SAMPLES) this.submitMs.shift() }
  recordAck(ms: number): void { this.ackMs.push(ms); if (this.ackMs.length > SAMPLES) this.ackMs.shift() }
  recordCallback(ms: number): void { this.callbackMs.push(ms); if (this.callbackMs.length > SAMPLES) this.callbackMs.shift() }

  private tick(): void {
    const now = Date.now()
    const elapsed = Math.max(1, now - this.lastAt)
    const publishedFps = (this.counters.published - this.lastPublished) * 1000 / elapsed
    const cpu = process.cpuUsage()
    const cpuPct = ((cpu.user - this.lastCpu.user) + (cpu.system - this.lastCpu.system)) / 1000 / elapsed * 100
    this.lastAt = now
    this.lastPublished = this.counters.published
    this.lastCpu = cpu
    const line = {
      t: new Date(now).toISOString(),
      kind: 'cuedeck-syphon-gpu-probe',
      gpu: true,
      ...this.counters,
      resolution: {
        width: this.width,
        height: this.height,
        targetWidth: this.targetWidth || null,
        targetHeight: this.targetHeight || null,
        targetMet: this.targetWidth && this.targetHeight
          ? this.width === this.targetWidth && this.height === this.targetHeight
          : null,
      },
      helperPid: this.helperPid,
      helperReady: this.ready,
      fps: { published: publishedFps },
      submitMs: { p95: p95(this.submitMs), max: this.submitMs.length ? Math.max(...this.submitMs) : 0 },
      ackMs: { p95: p95(this.ackMs), max: this.ackMs.length ? Math.max(...this.ackMs) : 0 },
      callbackMs: { p95: p95(this.callbackMs), max: this.callbackMs.length ? Math.max(...this.callbackMs) : 0 },
      readbackMs: { p95: 0, max: 0 },
      mainEventLoopMs: { p95: this.loop.percentile(95) / 1e6, max: this.loop.max / 1e6 },
      mainRssBytes: process.memoryUsage().rss,
      mainCpuPct: cpuPct,
    }
    this.loop.reset()
    try { this.stream?.write(`${JSON.stringify(line)}\n`) } catch { this.stream = null }
  }
}
