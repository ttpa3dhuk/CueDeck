/**
 * Dev-only main-process event-loop sampler, independent of the Syphon bridge.
 * It exists so a bridge-off baseline can provide the same p95/max main-loop
 * figures as a bridge-on run. Unpackaged + explicit env only; no frame tap and
 * no helper are involved. It does not run unless CUEDECK_LOOP_PROBE=1.
 */
import { app } from 'electron'
import { createWriteStream, type WriteStream } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'

let started = false

export function initLoopProbe(): void {
  if (started || app.isPackaged || process.env.CUEDECK_LOOP_PROBE !== '1') return
  const path = process.env.CUEDECK_LOOP_PROBE_PATH
  if (!path) return
  started = true

  let stream: WriteStream | null = null
  try {
    stream = createWriteStream(path, { flags: 'a' })
    stream.on('error', () => { stream = null })
  } catch {
    stream = null
  }
  const loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()
  let lastCpu = process.cpuUsage()
  let lastAt = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const elapsedMs = Math.max(1, now - lastAt)
    const cpu = process.cpuUsage()
    const cpuPct = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000 / elapsedMs * 100
    lastCpu = cpu
    lastAt = now
    const line = {
      t: new Date(now).toISOString(),
      kind: 'cuedeck-loop-probe',
      mainEventLoopMs: {
        p95: loop.percentile(95) / 1e6,
        max: loop.max / 1e6,
      },
      mainRssBytes: process.memoryUsage().rss,
      mainCpuPct: cpuPct,
    }
    loop.reset()
    try {
      stream?.write(`${JSON.stringify(line)}\n`)
    } catch {
      stream = null
    }
  }, 1000)
  timer.unref?.()
}
