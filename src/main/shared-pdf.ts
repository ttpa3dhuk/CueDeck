import { app, BrowserWindow, ipcMain, MessageChannelMain, screen, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { store, type WindowKey } from './state'
import { cachedPdfPathFor } from './pptx-converter'
import { SharedPdfRegistry, type PdfDeckSource } from './shared-pdf-registry'
import type { DeckFileData } from '../shared/pdf-source'
import type { PdfOwnerRequest, PdfOwnerReply, SharedPdfInfo } from '../shared/pdf-frames'
import { masterPdfRaster } from '../shared/pdf-frame-geometry'

const roles: WindowKey[] = ['operator', 'audience', 'speaker', 'gpu-prompter']
export const sharedPdfEnabled = process.env.CUEDECK_SHARED_PDF !== '0'
const registry = new SharedPdfRegistry()
let owner: BrowserWindow | null = null
let starting: Promise<void> | null = null
let stopped = false
let initialized = false
let seq = 0
let incarnation = 0
let observed = ''
let synchronized = ''
let syncTail: Promise<void> = Promise.resolve()
let readyResolve: (() => void) | null = null
let readyReject: ((error: Error) => void) | null = null
const replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
const consumers = new Map<number, { wc: WebContents; ids: Set<string> }>()
const tracked = new WeakSet<WebContents>()
let activeIds = new Set<string>()
let recoveryAttempts: number[] = []
let failure: string | null = null
let raster = { width: 1920, height: 1080 }

function decks(): PdfDeckSource[] {
  const state = store.get()
  const current = [
    { path: state.pdfPath, kind: state.fileKind, sha1: state.pdfSha1 }, state.preview,
  ]
  return current.flatMap(deck => deck.path && deck.sha1 && (deck.kind === 'pdf' || deck.kind === 'pptx')
    ? [{ path: deck.kind === 'pptx' ? cachedPdfPathFor(deck.sha1) : deck.path, sha1: deck.sha1 }] : [])
}
function signature(): string { return JSON.stringify(decks()) }
function notify(state: 'lost' | 'available'): void {
  for (const { wc } of consumers.values()) if (!wc.isDestroyed()) wc.send('pdf-frames:reset', { state, incarnation })
}
function rejectPending(error: Error): void {
  readyReject?.(error); readyResolve = null; readyReject = null
  for (const pending of replies.values()) { clearTimeout(pending.timer); pending.reject(error) }
  replies.clear()
}
function lost(win: BrowserWindow, reason: string): void {
  if (owner !== win) return
  owner = null; starting = null; synchronized = ''
  activeIds.clear()
  rejectPending(new Error(`PDF owner lost: ${reason}`))
  if (stopped) return
  log.error('[shared-pdf] owner lost', reason)
  failure = reason; notify('lost')
  recoveryAttempts = recoveryAttempts.filter(time => time > Date.now() - 60000)
  if (recoveryAttempts.length >= 3) return
  recoveryAttempts.push(Date.now())
  setTimeout(() => { if (!stopped) void synchronize().then(() => notify('available')).catch(error => log.error('[shared-pdf] recovery', error)) }, 200)
}

async function ensureOwner(): Promise<void> {
  if (stopped) throw new Error('PDF service stopped')
  if (owner && !owner.isDestroyed() && !starting) return
  if (starting) return starting
  failure = null
  const win = new BrowserWindow({ width: 64, height: 64, show: false, title: 'CueDeck PDF frame owner',
    webPreferences: { preload: join(__dirname, '../preload/pdf-owner.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  owner = win; incarnation++
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('render-process-gone', (_event, details) => { lost(win, details.reason); if (!win.isDestroyed()) win.destroy() })
  win.once('closed', () => lost(win, 'closed'))
  starting = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (owner === win) { lost(win, 'startup timeout'); if (!win.isDestroyed()) win.destroy() }
    }, 20000)
    readyResolve = () => { clearTimeout(timer); starting = null; resolve() }
    readyReject = error => { clearTimeout(timer); starting = null; reject(error) }
  })
  const ready = starting
  const base = process.env.ELECTRON_RENDERER_URL
  const load = base ? win.loadURL(`${base}/pdf-owner/index.html`) : win.loadFile(join(__dirname, '../renderer/pdf-owner/index.html'))
  void load.catch(error => { lost(win, String(error)); if (!win.isDestroyed()) win.destroy() })
  return ready
}

async function command(input: PdfOwnerRequest): Promise<unknown> {
  await ensureOwner()
  const win = owner!
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(id)
      reject(new Error(`PDF owner ${input.type} timed out`))
      lost(win, 'command timeout'); if (!win.isDestroyed()) win.destroy()
    }, 120000)
    replies.set(id, { resolve, reject, timer })
    try { win.webContents.send('pdf-owner:command', { ...input, seq: id }) }
    catch (error) { clearTimeout(timer); replies.delete(id); reject(error) }
  })
}

async function synchronize(): Promise<void> {
  const run = syncTail.catch(() => undefined).then(async () => {
    while (!stopped) {
      const wanted = signature()
      if (wanted === synchronized && owner && !owner.isDestroyed() && !starting) return
      const sources = await registry.reconcile(decks(), (source, error) => log.warn('[shared-pdf] unavailable revision', source.sha1, String(error)))
      if (wanted !== signature()) continue
      if (!sources.length && !owner) { synchronized = wanted; return }
      await command({ type: 'sync', sources })
      activeIds = new Set(sources.map(source => source.id))
      if (wanted !== signature()) continue
      synchronized = wanted
      return
    }
    throw new Error('PDF service stopped')
  })
  syncTail = run
  return run
}

function assertConsumer(event: IpcMainInvokeEvent): void {
  if (!sharedPdfEnabled || stopped || event.senderFrame !== event.sender.mainFrame ||
    !roles.some(role => store.registeredWindow(role)?.webContents === event.sender)) throw new Error('Unknown PDF consumer')
}
function track(wc: WebContents): { wc: WebContents; ids: Set<string> } {
  let consumer = consumers.get(wc.id)
  if (consumer) return consumer
  consumer = { wc, ids: new Set() }; consumers.set(wc.id, consumer)
  const release = () => {
    const current = consumers.get(wc.id)
    consumers.delete(wc.id)
    if (current && owner && !owner.isDestroyed()) for (const id of current.ids) {
      void command({ type: 'detach', id }).catch(() => undefined)
    }
  }
  if (!tracked.has(wc)) {
    tracked.add(wc)
    wc.once('destroyed', release)
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) release() })
  }
  return consumer
}

export function registerSharedPdfFrames(): void {
  if (initialized || !sharedPdfEnabled) return
  initialized = true
  raster = masterPdfRaster(screen.getAllDisplays())
  const refreshRaster = () => {
    if (stopped) return
    const next = masterPdfRaster(screen.getAllDisplays())
    if (next.width === raster.width && next.height === raster.height) return
    raster = next
    // Keep PDF workers/cache. Reconnect views so their cached geometry changes
    // together after a physical display/DPI change.
    if (owner && !starting) { notify('lost'); notify('available') }
  }
  screen.on('display-added', refreshRaster)
  screen.on('display-removed', refreshRaster)
  screen.on('display-metrics-changed', refreshRaster)
  ipcMain.on('pdf-owner:ready', event => {
    if (owner?.webContents === event.sender && event.senderFrame === event.sender.mainFrame) readyResolve?.()
  })
  ipcMain.on('pdf-owner:reply', (event, reply: PdfOwnerReply) => {
    if (owner?.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame || !Number.isSafeInteger(reply?.seq)) return
    const pending = replies.get(reply.seq)
    if (!pending) return
    replies.delete(reply.seq); clearTimeout(pending.timer)
    if (reply.ok) pending.resolve(reply.value)
    else pending.reject(new Error(reply.error ?? 'PDF owner failed'))
  })
  ipcMain.handle('pdf-frames:connect', async (event, requestId: string, clientId: string) => {
    assertConsumer(event)
    if (!/^[a-z0-9-]{1,96}$/i.test(requestId) || !/^[a-z0-9-]{1,40}$/i.test(clientId)) throw new Error('Invalid PDF connection')
    if (!owner || starting || !activeIds.size) await synchronize()
    assertConsumer(event)
    const consumer = track(event.sender)
    const id = `${event.sender.id}:${clientId}`
    if (consumer.ids.size >= 8 && !consumer.ids.has(id)) throw new Error('Too many PDF panes')
    consumer.ids.add(id)
    const { port1, port2 } = new MessageChannelMain()
    owner!.webContents.postMessage('pdf-owner:port', { id }, [port1])
    event.sender.postMessage('pdf-frames:port', { requestId }, [port2])
  })
  ipcMain.handle('pdf-frames:describe', async (event, id: string, page?: number): Promise<SharedPdfInfo> => {
    assertConsumer(event); track(event.sender)
    if (!activeIds.has(id) || !registry.has(id) || !owner || starting) await synchronize()
    if (!registry.has(id) || (page !== undefined && (!Number.isInteger(page) || page < 1))) throw new Error('Unknown PDF revision or page')
    return { ...await command({ type: 'describe', id, page }) as SharedPdfInfo, raster: { ...raster } }
  })
  ipcMain.handle('pdf-frames:stats', async event => {
    assertConsumer(event)
    return { enabled: true, ownerId: owner?.webContents.id ?? null, incarnation, failure, raster, documents: registry.sources().map(source => source.id),
      stats: owner && !starting ? await command({ type: 'stats' }) : null }
  })
  store.onChange(() => {
    const next = signature()
    if (next === observed) return
    observed = next
    void synchronize().catch(error => log.warn('[shared-pdf] document sync', error))
  })
}

export async function sharedPdfFile(path: string, sha1: string): Promise<DeckFileData> {
  if (!initialized) throw new Error('Shared PDF service is not initialized')
  let source = registry.get({ path, sha1 })
  if (!source || !activeIds.has(source.id) || !owner || starting) await synchronize()
  source = registry.get({ path, sha1 })
  if (!source) { synchronized = ''; await synchronize(); source = registry.get({ path, sha1 }) }
  if (!source) throw new Error('PDF is not one of the active decks')
  return { bytes: new Uint8Array(), mime: 'application/pdf', pdf: { ...source.file, shared: { id: source.id } } }
}
export async function resolveSharedPdf(url: URL): Promise<string | null> { return registry.resolve(url) }
export function stopSharedPdfFrames(): void {
  stopped = true
  rejectPending(new Error('PDF service stopped'))
  const win = owner; owner = null
  consumers.clear()
  if (win && !win.isDestroyed()) win.destroy()
}
