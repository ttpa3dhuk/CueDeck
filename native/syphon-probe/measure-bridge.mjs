#!/usr/bin/env node
/**
 * Sampler for a dev CueDeck + Syphon CPU-bridge run.
 *
 * It does NOT start CueDeck, Electron, Resolume or the helper. Start the one
 * existing dev build yourself, then run this with its main-process PID.
 *
 * Baseline: run CueDeck with CUEDECK_LOOP_PROBE=1 and
 * CUEDECK_LOOP_PROBE_PATH=/tmp/cuedeck-loop-baseline.ndjson.
 * Bridge:   run CueDeck with CUEDECK_SYPHON_BRIDGE=1 and
 * CUEDECK_SYPHON_BRIDGE_METRICS=/tmp/cuedeck-syphon-bridge.ndjson, then pass
 * that file as --metrics.
 *
 * The script samples RSS/%CPU with `ps` and reads the NDJSON metrics that the
 * app writes. It never estimates a value.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))

function usage(code = 0) {
  const out = code === 0 ? process.stdout : process.stderr
  out.write(`CueDeck Syphon CPU-bridge measurement sampler

Usage:
  node measure-bridge.mjs --main-pid PID [options]

Options:
  --main-pid PID       Existing CueDeck/Electron main-process PID (required)
  --helper-pid PID     Native helper PID (otherwise read helperPid from metrics)
  --metrics PATH       NDJSON from bridge metrics or loop probe
  --seconds N          Sampling duration, 1..300 (default 30)
  --interval SEC       Sample interval, 0.2..5 (default 1)
  --label NAME         Report label (default: run)
  --out PATH           Output JSON (default: build/metrics/<time>-<label>.json)
  --help

This sampler does not launch anything. Baseline and bridge runs must be separate
dev sessions; do not start a second CueDeck dev build.
`)
  process.exit(code)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function numberArg(name, fallback, min, max) {
  const at = process.argv.indexOf(name)
  if (at < 0) return fallback
  const value = Number(process.argv[at + 1])
  if (!Number.isFinite(value) || value < min || value > max) fail(`${name} must be ${min}..${max}`)
  return value
}

function stringArg(name, fallback = undefined) {
  const at = process.argv.indexOf(name)
  if (at < 0) return fallback
  const value = process.argv[at + 1]
  if (!value) fail(`${name} requires a value`)
  return value
}

if (process.argv.includes('--help') || process.argv.includes('-h')) usage(0)
const mainPid = Number(stringArg('--main-pid'))
if (!Number.isSafeInteger(mainPid) || mainPid <= 0) fail('--main-pid PID is required')
let helperPid = Number(stringArg('--helper-pid', '0'))
if (!Number.isSafeInteger(helperPid) || helperPid < 0) fail('bad --helper-pid')
const metricsPath = stringArg('--metrics')
const seconds = numberArg('--seconds', 30, 1, 300)
const intervalMs = numberArg('--interval', 1, 0.2, 5) * 1000
const label = (stringArg('--label', 'run')).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || 'run'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = stringArg('--out', join(ROOT, 'build', 'metrics', `${stamp}-${label}.json`))

const samples = []
let lastMetrics = null
let psFailures = 0

function p95(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

async function ps(pid) {
  if (!pid) return null
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)])
    const parts = stdout.trim().split(/\s+/)
    if (parts.length < 2) return null
    return {
      rssBytes: Math.round(Number(parts[0]) * 1024),
      cpuPct: Number(parts[1]),
    }
  } catch {
    psFailures++
    return null
  }
}

async function psTree(rootPid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='])
    const rows = []
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      const pid = Number(parts[0])
      const ppid = Number(parts[1])
      const rss = Number(parts[2])
      const cpu = Number(parts[3])
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
      rows.push({ pid, ppid, rssBytes: Math.round(rss * 1024), cpuPct: cpu, comm: parts.slice(4).join(' ') })
    }
    const byParent = new Map()
    for (const row of rows) {
      const list = byParent.get(row.ppid) ?? []
      list.push(row)
      byParent.set(row.ppid, list)
    }
    const queue = [rootPid]
    const seen = new Set()
    const processes = []
    while (queue.length) {
      const pid = queue.shift()
      if (seen.has(pid)) continue
      seen.add(pid)
      const row = rows.find(r => r.pid === pid)
      if (row) processes.push(row)
      for (const child of byParent.get(pid) ?? []) queue.push(child.pid)
    }
    if (!processes.length) return null
    return {
      processes,
      rssBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0),
      cpuPct: processes.reduce((sum, p) => sum + p.cpuPct, 0),
    }
  } catch {
    psFailures++
    return null
  }
}

function readMetrics() {
  if (!metricsPath || !existsSync(metricsPath)) return null
  try {
    const lines = readFileSync(metricsPath, 'utf8').split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i])
        if (parsed && typeof parsed === 'object') return parsed
      } catch {
        // A partially written last line is normal; try the previous one.
      }
    }
  } catch {
    return null
  }
  return null
}

function summary() {
  const mainRss = samples.map(s => s.main?.rssBytes ?? s.metrics?.mainRssBytes).filter(v => Number.isFinite(v))
  const mainCpu = samples.map(s => s.main?.cpuPct ?? s.metrics?.mainCpuPct).filter(v => Number.isFinite(v))
  const helperRss = samples.map(s => s.helper?.rssBytes).filter(v => Number.isFinite(v))
  const helperCpu = samples.map(s => s.helper?.cpuPct).filter(v => Number.isFinite(v))
  const treeRss = samples.map(s => s.tree?.rssBytes).filter(v => Number.isFinite(v))
  const treeCpu = samples.map(s => s.tree?.cpuPct).filter(v => Number.isFinite(v))
  const treeCount = samples.map(s => s.tree?.processes?.length).filter(v => Number.isFinite(v))
  const eventP95 = samples.map(s => s.metrics?.mainEventLoopMs?.p95).filter(v => Number.isFinite(v))
  const eventMax = samples.map(s => s.metrics?.mainEventLoopMs?.max).filter(v => Number.isFinite(v))
  const callbackP95 = samples.map(s => s.metrics?.callbackMs?.p95).filter(v => Number.isFinite(v))
  const callbackMax = samples.map(s => s.metrics?.callbackMs?.max).filter(v => Number.isFinite(v))
  const resizeP95 = samples.map(s => s.metrics?.resizeMs?.p95).filter(v => Number.isFinite(v))
  const resizeMax = samples.map(s => s.metrics?.resizeMs?.max).filter(v => Number.isFinite(v))
  const readbackP95 = samples.map(s => s.metrics?.readbackMs?.p95).filter(v => Number.isFinite(v))
  const readbackMax = samples.map(s => s.metrics?.readbackMs?.max).filter(v => Number.isFinite(v))
  const ackP95 = samples.map(s => s.metrics?.ackMs?.p95).filter(v => Number.isFinite(v))
  const submitP95 = samples.map(s => s.metrics?.submitMs?.p95).filter(v => Number.isFinite(v))
  const fps = samples.map(s => s.metrics?.fps?.published).filter(v => Number.isFinite(v))
  const last = lastMetrics
  return {
    samples: samples.length,
    psAvailable: samples.some(s => s.main !== null || s.helper !== null || s.tree !== null),
    mainMetricsFallback: samples.some(s => s.main === null && Number.isFinite(s.metrics?.mainRssBytes)),
    psFailures,
    mainRssBytes: { avg: mainRss.length ? mainRss.reduce((a, b) => a + b, 0) / mainRss.length : null, max: mainRss.length ? Math.max(...mainRss) : null },
    mainCpuPct: { avg: mainCpu.length ? mainCpu.reduce((a, b) => a + b, 0) / mainCpu.length : null, max: mainCpu.length ? Math.max(...mainCpu) : null },
    helperRssBytes: { avg: helperRss.length ? helperRss.reduce((a, b) => a + b, 0) / helperRss.length : null, max: helperRss.length ? Math.max(...helperRss) : null },
    helperCpuPct: { avg: helperCpu.length ? helperCpu.reduce((a, b) => a + b, 0) / helperCpu.length : null, max: helperCpu.length ? Math.max(...helperCpu) : null },
    processTree: {
      processes: treeCount.length ? Math.max(...treeCount) : null,
      rssBytes: { avg: treeRss.length ? treeRss.reduce((a, b) => a + b, 0) / treeRss.length : null, max: treeRss.length ? Math.max(...treeRss) : null },
      cpuPct: { avg: treeCpu.length ? treeCpu.reduce((a, b) => a + b, 0) / treeCpu.length : null, max: treeCpu.length ? Math.max(...treeCpu) : null },
    },
    mainEventLoopMs: {
      p95OfP95: p95(eventP95),
      p95Max: eventP95.length ? Math.max(...eventP95) : null,
      max: eventMax.length ? Math.max(...eventMax) : null,
    },
    callbackMs: {
      p95OfP95: p95(callbackP95),
      p95Max: callbackP95.length ? Math.max(...callbackP95) : null,
      max: callbackMax.length ? Math.max(...callbackMax) : null,
    },
    resizeMs: {
      p95OfP95: p95(resizeP95),
      p95Max: resizeP95.length ? Math.max(...resizeP95) : null,
      max: resizeMax.length ? Math.max(...resizeMax) : null,
    },
    readbackMs: {
      p95OfP95: p95(readbackP95),
      p95Max: readbackP95.length ? Math.max(...readbackP95) : null,
      max: readbackMax.length ? Math.max(...readbackMax) : null,
    },
    submitMs: {
      p95OfP95: p95(submitP95),
      p95Max: submitP95.length ? Math.max(...submitP95) : null,
    },
    ackMs: {
      p95OfP95: p95(ackP95),
      p95Max: ackP95.length ? Math.max(...ackP95) : null,
    },
    publishedFps: {
      avg: fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : null,
      min: fps.length ? Math.min(...fps) : null,
    },
    bridgeCounters: last ? {
      captured: last.captured,
      sent: last.sent,
      published: last.published,
      droppedBusy: last.droppedBusy,
      droppedNoHelper: last.droppedNoHelper,
      invalidFrame: last.invalidFrame,
      timeouts: last.timeouts,
      helperRestarts: last.helperRestarts,
      writeErrors: last.writeErrors,
    } : null,
    helperPid: last?.helperPid ?? (helperPid || null),
  }
}

async function main() {
  const start = Date.now()
  let lastSampleAt = 0
  while (Date.now() - start < seconds * 1000) {
    const now = Date.now()
    const [main, helper, tree, metrics] = await Promise.all([
      ps(mainPid),
      ps(helperPid),
      psTree(mainPid),
      Promise.resolve(readMetrics()),
    ])
    if (metrics) {
      lastMetrics = metrics
      if (!helperPid && Number.isSafeInteger(metrics.helperPid) && metrics.helperPid > 0) helperPid = metrics.helperPid
    }
    samples.push({ at: new Date(now).toISOString(), main, helper, tree, metrics })
    lastSampleAt = now
    const wait = Math.max(0, intervalMs - (Date.now() - now))
    await new Promise(resolve => setTimeout(resolve, wait))
  }
  const report = {
    kind: 'cuedeck-syphon-bridge-measurement',
    label,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date().toISOString(),
    durationSec: (Date.now() - start) / 1000,
    mainPid,
    helperPid: helperPid || null,
    metricsPath: metricsPath ?? null,
    lastSampleAt: lastSampleAt ? new Date(lastSampleAt).toISOString() : null,
    summary: summary(),
    samples,
  }
  mkdirSync(dirname(outPath), { recursive: true })
  if (!report.summary.psAvailable && !report.summary.mainMetricsFallback) {
    process.stderr.write('warning: ps could not read the target process and metrics had no main RSS/CPU\n')
  }
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ out: outPath, label, summary: report.summary })}\n`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
