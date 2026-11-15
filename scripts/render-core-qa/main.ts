/** Standalone production-built QA application. Does not import CueDeck main,
 * settings, dev startup, native outputs, updater or project code. */
import { app, BrowserWindow, ipcMain, MessageChannelMain, protocol, nativeImage } from 'electron'
import { writeFile, open, stat } from 'node:fs/promises'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

if (!process.env.RENDER_QA_CONFIG) throw new Error('RENDER_QA_CONFIG is required')
const config = JSON.parse(readFileSync(process.env.RENDER_QA_CONFIG, 'utf8'))
const output = resolve(config.output)
mkdirSync(output, { recursive: true })
app.setName('CueDeck Render Core QA')
app.setPath('userData', join(output, 'qa-chromium'))
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
protocol.registerSchemesAsPrivileged([{ scheme: 'renderqa', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }])
const report: any = { runtime: process.versions, platform: process.platform, config: {
  mode: config.mode, width: config.width ?? 960, height: config.height ?? 540, fixture: config.fixture ?? 0,
}, phases: [], samples: [], metrics: [], errors: [], pixelStrictPass: true }
const windows: BrowserWindow[] = []
const ready = new Map<number, () => void>()
let finishRequested = false
let monitor: ReturnType<typeof setInterval> | undefined
const handles: Awaited<ReturnType<typeof open>>[] = []
async function run() {
const fixtureInputs: string[] = config.files
const fixtures = await Promise.all(fixtureInputs.map(async (path: string, i: number) => {
  const info = await stat(path)
  const handle = await open(path, 'r'); handles.push(handle)
  return { path, size: info.size, mtime: info.mtimeMs, id: `revision-${i}-${info.size}-${info.mtimeMs}`,
    file: { url: `renderqa://fixture/${i}`, size: info.size }, handle }
}))
const rendererConfig = { documents: fixtures.map(({ id, file }) => ({ id, file })),
  width: config.width ?? 960, height: config.height ?? 540,
  cacheBytes: 96 * 1024 * 1024, deliveryBytes: 64 * 1024 * 1024 }

function metrics() {
  report.metrics.push({ at: Date.now(), processes: app.getAppMetrics(), main: process.memoryUsage() })
  if (existsSync(join(output, 'abort.json'))) void finish(new Error('QA stopped by resource monitor'))
}
async function bounded<T>(promise: Promise<T>, ms = 120000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('QA operation timed out')), ms)
  })]) } finally { clearTimeout(timer!) }
}
async function call(win: BrowserWindow, method: string, args: unknown[] = []): Promise<any> {
  return bounded(win.webContents.executeJavaScript(`window.qa[${JSON.stringify(method)}](...${JSON.stringify(args)})`))
}
async function until(fn: () => Promise<boolean>) {
  const deadline = Date.now() + 120000
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('QA readiness timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
async function make(role: string, i: number): Promise<BrowserWindow> {
  const win = new BrowserWindow({ title: `Render Core QA ${role} ${i}`, width: 480, height: 298,
    useContentSize: true, x: 20 + (i % 2) * 490, y: 40 + Math.floor(i / 2) * 330,
    show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  windows.push(win)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('render-process-gone', (_, details) => {
    if (!finishRequested) report.errors.push({ kind: 'renderer-gone', role, i, details })
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) report.errors.push({ kind: 'console', role, i, message: message.slice(0, 500) })
  })
  const initialized = new Promise<void>(resolve => ready.set(win.webContents.id, resolve))
  await win.loadFile(join(__dirname, 'renderer/index.html'), { query: { role, id: String(i) } })
  if (role !== 'owner') win.showInactive()
  await bounded(initialized)
  return win
}
ipcMain.on('render-qa:ready', event => ready.get(event.sender.id)?.())
ipcMain.handle('render-qa:config', event => {
  if (!windows.some(win => win.webContents.id === event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('Unknown QA window')
  return rendererConfig
})

async function finish(error?: unknown) {
  if (finishRequested) return
  finishRequested = true
  if (monitor) clearInterval(monitor)
  if (error) report.errors.push({ kind: 'driver', message: String(error), stack: error instanceof Error ? error.stack : null })
  report.finishedAt = Date.now()
  report.pass = !report.errors.length
  try { await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2)) }
  finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    await Promise.all(handles.map(handle => handle.close()))
    app.exit(report.pass ? 0 : 1)
  }
}

await app.whenReady()
protocol.handle('renderqa', async request => {
  const url = new URL(request.url)
  const index = Number(url.pathname.slice(1))
  const fixture = fixtures[index]
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range') ?? '')
  if (url.hostname !== 'fixture' || !fixture || !match) return new Response(null, { status: 403 })
  const start = Number(match[1]), end = Number(match[2]) + 1
  const current = await fixture.handle.stat()
  if (current.size !== fixture.size || current.mtimeMs !== fixture.mtime || start < 0 || end > fixture.size || start >= end) return new Response(null, { status: 409 })
  const bytes = new Uint8Array(end - start)
  let offset = 0
  while (offset < bytes.length) {
    const result = await fixture.handle.read(bytes, offset, bytes.length - offset, start + offset)
    if (!result.bytesRead) return new Response(null, { status: 500 })
    offset += result.bytesRead
  }
  return new Response(bytes, { status: 206, headers: { 'Content-Type': 'application/pdf',
    'Content-Range': `bytes ${start}-${end - 1}/${fixture.size}`, 'Content-Length': String(bytes.length),
    'Access-Control-Allow-Origin': '*' } })
})

try {
  const count = config.consumers ?? 4
  const owner = config.mode === 'shared' ? await make('owner', 0) : null
  const clients: BrowserWindow[] = []
  for (let i = 0; i < count; i++) clients.push(await make(owner ? 'client' : 'baseline', i))
  // Quality runs are separate from performance runs: a real candidate loader
  // renders each page independently instead of trusting agreement among clones.
  const reference = config.reference ? await make('baseline', count) : null
  if (owner) {
    for (let i = 0; i < count; i++) {
      const channel = new MessageChannelMain()
      owner.webContents.postMessage('render-qa:port', { id: `display-${i}` }, [channel.port1])
      clients[i].webContents.postMessage('render-qa:port', { id: `display-${i}` }, [channel.port2])
    }
    report.documents = await call(owner, 'replace', [[config.fixture ?? 0]])
    await until(async () => (await Promise.all(clients.map(win => call(win, 'ready')))).every(Boolean))
  }
  metrics(); monitor = setInterval(metrics, 500)
  const document = fixtures[config.fixture ?? 0].id
  const pages: number[] = config.pages ?? [1, 2, 3, 2, 1]
  for (const page of pages) {
    const start = performance.now()
    const frames = await Promise.all(clients.map(win => call(win, 'request', [document, page])))
    report.samples.push({ page, ms: performance.now() - start, frames })
    if (frames.some(frame => !frame.painted)) throw new Error(`Receiver did not paint page ${page}`)
    if (reference) {
      const expected = await call(reference, 'request', [document, page])
      let changed = 0, max = 0
      if (expected.hash !== frames[0].hash) {
        const actualPng = await call(clients[0], 'snapshot'), expectedPng = await call(reference, 'snapshot')
        const actual = nativeImage.createFromDataURL(actualPng).toBitmap()
        const golden = nativeImage.createFromDataURL(expectedPng).toBitmap()
        for (let j = 0; j < actual.length; j++) { const delta = Math.abs(actual[j] - golden[j]); if (delta) changed++; max = Math.max(max, delta) }
        await writeFile(join(output, `quality-${page}-actual.png`), nativeImage.createFromDataURL(actualPng).toPNG())
        await writeFile(join(output, `quality-${page}-candidate.png`), nativeImage.createFromDataURL(expectedPng).toPNG())
      }
      report.samples.at(-1).quality = { exact: expected.hash === frames[0].hash, changedChannels: changed, maxDelta: max }
      // Exact comparisons are reported separately. Up to 128 channels out of
      // 2,073,600 at max64/255 is a deliberately bounded non-exact result, not
      // a pixel-perfect PASS. Missing images/geometry cannot pass this criterion.
      if (changed > 128 || max > 64) throw new Error(`Candidate pixel reference failed on page ${page}: ${changed} channels, max${max}`)
    }
    if (new Set(frames.map(frame => frame.hash)).size !== 1) {
      const shots = await Promise.all(clients.map(win => call(win, 'snapshot')))
      const pixels = shots.map(shot => nativeImage.createFromDataURL(shot).toBitmap())
      const differences = pixels.slice(1).map(other => {
        let max = 0, changed = 0
        for (let j = 0; j < other.length; j++) { const delta = Math.abs(other[j] - pixels[0][j]); max = Math.max(max, delta); if (delta) changed++ }
        return { max, changed }
      })
      report.phases.push({ pixelDivergence: page, differences })
      report.pixelStrictPass = false
      for (let i = 0; i < shots.length; i++) await writeFile(join(output, `divergence-${page}-${i}.png`), nativeImage.createFromDataURL(shots[i]).toPNG())
      // Control disagreements are observations about the unchanged candidate,
      // not proof that the new shared transport failed. Retain exact differences
      // and pixelStrictPass=false; shared receivers must be byte-identical.
      if (owner) throw new Error(`Shared receivers disagree on page ${page}`)
    }
    if ([pages[0], pages[Math.floor(pages.length / 2)], pages.at(-1)].includes(page)) {
      const shot = await clients[clients.length - 1].webContents.capturePage({ x: 0, y: 28, width: 480, height: 270 })
      const png = shot.toPNG()
      await writeFile(join(output, `receiver-${page}.png`), png)
      report.phases.push({ capturePage: page, size: shot.getSize(), pngSha256: createHash('sha256').update(png).digest('hex') })
    }
    await writeFile(join(output, 'progress.json'), JSON.stringify({ page, completed: report.samples.length, total: pages.length }))
  }
  report.primaryMetricSamples = report.metrics.length
  if (owner) report.primaryStats = await call(owner, 'stats')
  if (owner && config.lifecycle !== false) {
    const slow = clients[count - 1]
    await call(slow, 'delayAck')
    await call(slow, 'request', [document, pages[0]])
    const blocked = call(slow, 'request', [document, pages[1]])
    const pgm = await call(clients[0], 'request', [document, pages.at(-1)])
    if (!pgm.painted) throw new Error('Slow receiver blocked program')
    await call(slow, 'releaseAck'); await blocked
    report.phases.push({ slowReceiver: 'PASS', transport: await call(owner, 'stats') })
    const burst = await call(clients[0], 'burst', [document, [pages[0], pages[1], pages[2], pages[0]]])
    if (burst.results.filter(Boolean).length !== 1 || !burst.results.at(-1)) throw new Error('Obsolete burst pages were painted')
    report.phases.push({ burst })
    await call(slow, 'delayFrames')
    const delayed = call(slow, 'request', [document, pages[0]])
    await until(async () => (await call(slow, 'stats')).heldFrames === 1)
    const previousHash = await call(slow, 'hash')
    await call(owner, 'replace', [[0, 1]])
    if ((await delayed).painted) throw new Error('Old generation painted after reset')
    await call(slow, 'releaseFrames')
    if ((await call(slow, 'hash')) !== previousHash) throw new Error('Late frame changed the reset display')
    report.phases.push({ lateGeneration: 'PASS', receiver: await call(slow, 'stats') })
    await until(async () => (await call(clients[0], 'stats')).documents?.length === 2)
    const mixed = await Promise.all(clients.map((win, i) => call(win, 'request', [fixtures[i === count - 1 ? 1 : 0].id, i === count - 2 ? 4 : 3])))
    if (mixed[0].hash === mixed.at(-1).hash) throw new Error('Preview did not show the other document')
    if (mixed[0].hash === mixed[count - 2].hash) throw new Error('Next-slide receiver did not show its own page')
    report.phases.push({ mixed, stats: await call(owner, 'stats') })
    const sized = []
    for (const [width, height] of [[1280,720],[1920,1080]]) {
      const frame = await call(clients[0], 'sized', [fixtures[0].id, 3, width, height])
      if (!frame.painted || frame.width !== width || frame.height !== height) throw new Error('Frame size mismatch')
      sized.push(frame)
    }
    report.phases.push({ sized, stats: await call(owner, 'stats') })
    // Close one receiver with an unacknowledged transferred allocation.
    await call(slow, 'delayAck'); await call(slow, 'request', [fixtures[1].id, 2])
    await call(slow, 'close'); slow.destroy()
    await call(clients[0], 'request', [fixtures[0].id, 2])
    report.phases.push({ closedReceiver: 'PASS', stats: await call(owner, 'stats') })
    report.stopped = await call(owner, 'stop')
    if (report.stopped.residentBytes !== 0 || report.stopped.inFlightBytes !== 0) throw new Error('Resources remained after stop')
  } else if (!owner) {
    await Promise.all(clients.map(win => call(win, 'stop')))
  } else report.stopped = await call(owner, 'stop')
  metrics()
  if (reference) await call(reference, 'stop')
  await finish()
} catch (error) { await finish(error) }

}
void run().catch(error => { console.error(error); app.exit(1) })
