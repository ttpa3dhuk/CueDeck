import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import type { MobileClickerStorage } from './mobile-clicker-storage.js'
import { mobileClickerPage } from './mobile-clicker-page.js'
import { t } from '../shared/i18n.js'
import type { MobileClickerStatus, MobileClickerSnapshot } from '../shared/mobile-clicker.js'

/** A separate, persistent capability grants only state/next/prev, never remote API access. */
export class MobileClicker {
  private server: Server | null = null
  private key = ''
  private generation = 0
  private loaded = false
  private port = 0
  private savedEnabled = false
  private state: MobileClickerStatus = { enabled: false, urls: [], qr: null, error: null }
  private serial = Promise.resolve()
  private seen = new Map<string, number>()
  private pending = 0
  private commandChain: Promise<unknown> = Promise.resolve()
  constructor(private snapshot: () => MobileClickerSnapshot, private command: (direction: 'next' | 'prev') => void | Promise<void>,
    private hosts: () => string[] = () => Object.values(networkInterfaces()).flatMap(items => (items ?? [])
      .filter(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')).map(item => item.address)),
    private bindHost = '0.0.0.0', private storage?: MobileClickerStorage) {}

  status(): MobileClickerStatus { return { ...this.state, urls: [...this.state.urls] } }
  async qr(index: number): Promise<string | null> {
    const url = Number.isInteger(index) ? this.state.urls[index] : null
    return url ? QRCode.toDataURL(url, { width: 400, margin: 4, errorCorrectionLevel: 'H' }) : null
  }

  setEnabled(enabled?: boolean): Promise<MobileClickerStatus> {
    const operation = this.serial.then(async () => {
      if (!this.loaded) {
        const saved = await this.storage?.load()
        if (saved) { this.key = saved.key; this.port = saved.port; this.savedEnabled = saved.enabled }
        this.loaded = true
      }
      const active = enabled ?? this.savedEnabled
      if (this.server) {
        await this.storage?.save({ key: this.key, port: this.port, enabled: active })
        this.generation++; this.state.enabled = active; return this.status()
      }
      if (!active && !this.port) return this.status()
      if (!this.key) this.key = randomBytes(32).toString('base64url')
      const server = createServer((request, response) => { void this.handle(request, response).catch(() => this.reply(response, 500, { error: 'Command failed' })) })
      server.headersTimeout = 5000; server.requestTimeout = 5000
      server.maxConnections = 32
      this.server = server
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.port, this.bindHost, () => { server.removeListener('error', reject); resolve() }) })
        const address = server.address()
        if (!address || typeof address === 'string') throw Error('No listening address')
        this.port = address.port
        await this.storage?.save({ key: this.key, port: this.port, enabled: active })
        const urls = this.hosts().map(host => 'http://' + host + ':' + address.port + '/#key=' + this.key)
        this.state = { enabled: active, urls, qr: urls[0] ? await QRCode.toDataURL(urls[0], { width: 400, margin: 4, errorCorrectionLevel: 'H' }) : null,
          error: urls.length ? null : t('Нет адреса локальной сети') }
        server.on('error', () => { this.state.error = t('Ошибка сервера мобильного кликера') })
      } catch {
        await this.stop()
        this.state.error = t('Не удалось запустить мобильный кликер')
      }
      return this.status()
    })
    this.serial = operation.then(() => undefined, () => undefined)
    return operation
  }

  resetLink(): Promise<MobileClickerStatus> {
    const operation = this.serial.then(async () => {
      if (!this.server) return this.status()
      const oldKey = this.key
      const newKey = randomBytes(32).toString('base64url')
      await this.storage?.save({ key: newKey, port: this.port, enabled: this.state.enabled })
      this.key = newKey
      this.generation++; this.seen.clear()
      this.state.urls = this.state.urls.map(url => url.replace('#key=' + oldKey, '#key=' + this.key))
      this.state.qr = await this.qr(0)
      return this.status()
    })
    this.serial = operation.then(() => undefined, () => undefined)
    return operation
  }

  async dispose(): Promise<void> { await this.serial; await this.stop() }

  private async stop(): Promise<void> {
    this.generation++; this.seen.clear()
    const server = this.server; this.server = null
    this.state = { enabled: false, urls: [], qr: null, error: null }
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }

  private reply(response: ServerResponse, status: number, data: unknown): void {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(JSON.stringify(data))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = (request.url ?? '').split('?')[0]
    if (pathname === '/' && request.method === 'GET') {
      const page = mobileClickerPage()
      const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]
      const hash = createHash('sha256').update(script).digest('base64')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, 'X-Content-Type-Options': 'nosniff' })
      response.end(page); return
    }
    const token = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(this.key)
    if (!expected.length || token.length !== expected.length || !timingSafeEqual(token, expected)) { this.reply(response, 401, { error: 'Unauthorized' }); return }
    const origin = request.headers.origin
    if (origin && origin !== 'http://' + request.headers.host) { this.reply(response, 403, { error: 'Wrong origin' }); return }
    if (pathname === '/state' && request.method === 'GET') { this.reply(response, 200, { ...this.snapshot(), enabled: this.state.enabled }); return }
    if (pathname !== '/command' || request.method !== 'POST') { this.reply(response, 404, { error: 'Not found' }); return }
    if (this.pending >= 16) { this.reply(response, 429, { error: 'Busy' }); return }
    const key = this.key
    const generation = this.generation
    let body = ''
    for await (const chunk of request) { body += chunk.toString(); if (body.length > 2048) { this.reply(response, 413, { error: 'Too large' }); return } }
    let payload: { direction?: unknown; id?: unknown }
    try { payload = JSON.parse(body) } catch { this.reply(response, 400, { error: 'Invalid command' }); return }
    if (!payload || Array.isArray(payload) || (payload.direction !== 'next' && payload.direction !== 'prev') || typeof payload.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.id)) { this.reply(response, 400, { error: 'Invalid command' }); return }
    const id = payload.id
    const now = Date.now()
    for (const [id, timestamp] of this.seen) if (now - timestamp > 60_000) this.seen.delete(id)
    if (this.seen.has(id)) { this.reply(response, 200, { ok: true }); return }
    this.seen.set(id, now)
    while (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!)
    this.pending++
    const operation = this.commandChain.then(async () => {
      if (!key || key !== this.key || generation !== this.generation || !this.state.enabled || !this.snapshot().canNavigate) throw Error('Clicker unavailable')
      await this.command(payload.direction as 'next' | 'prev')
    })
    this.commandChain = operation.catch(() => undefined)
    try { await operation; this.reply(response, 200, { ok: true }) }
    finally { this.pending-- }
  }
}
