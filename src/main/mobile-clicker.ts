import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import type { MobileClickerStorage } from './mobile-clicker-storage.js'
import { mobileClickerPage } from './mobile-clicker-page.js'
import { t } from '../shared/i18n.js'
import type { MobileClickerStatus, MobileClickerSnapshot, ClickerAccess, ClickerGrant, ClickerClient, ClickerInvitation } from '../shared/mobile-clicker.js'

/** A separate, persistent capability grants only state/next/prev, never remote API access. */
export class MobileClicker {
  private server: Server | null = null
  private cloudServer: Server | null = null
  private cloudPort = 0
  private key = ''
  private generation = 0
  private loaded = false
  private port = 0
  private savedEnabled = false
  private state: MobileClickerStatus = { enabled: false, urls: [], qr: null, error: null }
  private serial = Promise.resolve()
  private seen = new Map<string, number>()
  private pending = 0
  private access: ClickerAccess = { online: false, publicUrl: '', grants: [] }
  private clients = new Map<string, ClickerClient>()
  private direct = new Map<string, { grant: ClickerGrant; expires: number; approved: boolean; clientId: string }>()
  private joining = 0
  private joinRate = { tokens: 4, time: Date.now() }
  setGuestAccess(open: boolean, presentations: string[] | null): Promise<MobileClickerStatus> {
    return this.enqueue(async () => {
      if (!this.server) throw Error(t('Сначала включите кликер'))
      if (open) this.validatePresentations(presentations)
      const scope = presentations === null ? null : [...presentations]
      const next = { ...this.access, guestOpen: open === true, guestPresentations: scope }
      // Disabling open admission takes effect even if disk persistence fails.
      if (!open) { this.access.guestOpen = false; this.generation++; for (const c of this.clients.values()) if (c.direct) c.blocked = true; this.updatePage() }
      await this.persist(this.key, this.state.enabled, next); this.access = next; this.generation++
      this.updatePage()
      for (const [id, session] of this.direct) {
        session.grant.presentations = open ? scope : []
        session.approved = open
        session.expires = Date.now() + (open ? 12 * 60 * 60 * 1000 : 120000)
        for (const c of this.clients.values()) if (c.grantId === id) c.blocked = !open || Boolean(c.operatorBlocked)
      }
      return this.status()
    })
  }
  private expireDirect(): void {
    for (const [id, session] of this.direct) if (session.expires <= Date.now()) {
      this.direct.delete(id); this.generation++
      for (const [key, client] of this.clients) if (client.grantId === id) this.clients.delete(key)
    }
  }
  approveClient(id: string, presentations: string[] | null): MobileClickerStatus {
    this.expireDirect(); this.validatePresentations(presentations)
    const client = this.clients.get(id)
    const session = client && this.direct.get(client.grantId)
    if (!client || !session) throw Error(t('Запрос доступа истёк. Попросите пользователя подключиться заново'))
    session.grant.presentations = presentations === null ? null : [...new Set(presentations)]
    session.approved = true; session.expires = Date.now() + 12 * 60 * 60 * 1000
    client.pending = false; client.blocked = false; client.operatorBlocked = false; this.generation++
    return this.status()
  }
  disconnectClient(id: string): MobileClickerStatus {
    const client = this.clients.get(id)
    if (client?.direct) { this.direct.delete(client.grantId); this.clients.delete(id); this.generation++ }
    return this.status()
  }
  private rates = new Map<string, { tokens: number; time: number }>()
  private page = ''
  private pageHash = ''
  private updatePage(): void {
    this.page = mobileClickerPage({ guestOpen: this.access.guestOpen === true })
    this.pageHash = createHash('sha256').update(this.page.match(/<script>([\s\S]*?)<\/script>/)![1]).digest('base64')
  }
  private probe: { nonce: string; expires: number } | null = null
  connectionProbe(): string {
    const nonce = randomBytes(24).toString('hex')
    this.probe = { nonce, expires: Date.now() + 30000 }; return nonce
  }
  clearProbe(): void { this.probe = null }
  private globalRate = { tokens: 120, time: Date.now() }
  private commandRate = { tokens: 4, time: Date.now() }

  private consume(bucket: { tokens: number; time: number }, rate: number, capacity: number): boolean {
    const now = Date.now()
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.time) * rate / 1000); bucket.time = now
    if (bucket.tokens < 1) return false
    bucket.tokens--; return true
  }
  private limited(id: string, rate: number, capacity: number): boolean {
    let bucket = this.rates.get(id)
    if (!bucket) {
      if (this.rates.size >= 512) return true
      bucket = { tokens: capacity, time: Date.now() }; this.rates.set(id, bucket)
    }
    return !this.consume(bucket, rate, capacity)
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn); this.serial = result.then(() => undefined, () => undefined); return result
  }
  private persist(key = this.key, enabled = this.state.enabled, access = this.access): Promise<void> {
    return this.storage?.save({ key, port: this.port, cloudPort: this.cloudPort, enabled, access }) ?? Promise.resolve()
  }
  private allowed(grant: ClickerGrant | undefined, snapshot: MobileClickerSnapshot): boolean {
    return !grant || grant.presentations === null || Boolean(snapshot.presentationId && grant.presentations.includes(snapshot.presentationId))
  }
  configure(online: boolean, publicUrl: string): Promise<MobileClickerStatus> {
    return this.enqueue(async () => {
      if (!this.server) throw Error(t('Сначала включите кликер'))
      let canonical = ''
      if (publicUrl) {
        const url = new URL(publicUrl)
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || url.hostname === 'localhost' || !url.hostname.includes('.')) throw Error(t('Укажите публичный HTTPS-адрес CLOUDPUB без пути и параметров'))
        canonical = url.origin
      }
      if (online && !canonical) throw Error(t('Укажите HTTPS-адрес CLOUDPUB'))
      const next = { ...this.access, online: online === true, publicUrl: canonical }
      // Disabling access must take effect even if saving settings fails.
      if (!next.online) { this.access = { ...this.access, online: false }; this.generation++ }
      await this.persist(this.key, this.state.enabled, next); this.access = next; this.generation++
      return this.status()
    })
  }
  createGrant(name: string, presentations: string[] | null): Promise<MobileClickerStatus> {
    return this.enqueue(async () => {
      if (!this.server) throw Error(t('Сначала включите кликер'))
      if (this.access.grants.length >= 64) throw Error(t('Достигнут лимит 64 ссылок. Отзовите ненужные ссылки'))
      if (typeof name !== 'string' || name.trim().length > 80) throw Error(t('Имя ссылки не должно быть длиннее 80 символов'))
      this.validatePresentations(presentations)
      const grant: ClickerGrant = { id: randomBytes(16).toString('hex'), name: name.trim() || t('Мобильный кликер'), key: randomBytes(32).toString('base64url'), presentations: presentations === null ? null : [...new Set(presentations)] }
      const next = { ...this.access, grants: [...this.access.grants, grant] }
      await this.persist(this.key, this.state.enabled, next); this.access = next
      return this.status()
    })
  }
  revokeGrant(id: string): Promise<MobileClickerStatus> {
    return this.enqueue(async () => {
      const next = { ...this.access, grants: this.access.grants.filter(g => g.id !== id) }
      await this.persist(this.key, this.state.enabled, next); this.access = next; this.generation++
      for (const [key, client] of this.clients) if (client.grantId === id) this.clients.delete(key)
      return this.status()
    })
  }
  updateGrant(id: string, presentations: string[] | null): Promise<MobileClickerStatus> {
    return this.enqueue(async () => {
      if (!this.access.grants.some(g => g.id === id)) throw Error(t('Разрешение отозвано'))
      this.validatePresentations(presentations)
      const next = { ...this.access, grants: this.access.grants.map(g => g.id === id ? { ...g, presentations: presentations === null ? null : [...new Set(presentations)] } : g) }
      await this.persist(this.key, this.state.enabled, next); this.access = next; this.generation++
      return this.status()
    })
  }
  private validatePresentations(presentations: string[] | null): void {
    if (Array.isArray(presentations) && presentations.length === 0) throw Error(t('Выберите хотя бы одну презентацию'))
    if (presentations !== null && (!Array.isArray(presentations) || presentations.length > 500 || presentations.some(id => typeof id !== 'string' || !id || id.length > 200))) throw Error(t('Некорректное разрешение'))
  }
  blockClient(id: string, blocked: boolean): MobileClickerStatus {
    const client = this.clients.get(id)
    if (client) { client.pending = false; client.blocked = blocked === true; if (client.direct) client.operatorBlocked = blocked === true; this.generation++ }
    return this.status()
  }
  async invitation(id: string): Promise<ClickerInvitation> {
    const grant = this.access.grants.find(g => g.id === id)
    if (!grant) throw Error(t('Разрешение отозвано'))
    const base = this.access.online ? this.access.publicUrl : this.state.urls[0]?.split('/#')[0]
    if (!base) throw Error(t('Нет адреса кликера'))
    const url = base + '/#key=' + grant.key
    return { url, qr: await QRCode.toDataURL(url, { width: 400, margin: 4, errorCorrectionLevel: 'H' }) }
  }
  constructor(private snapshot: () => MobileClickerSnapshot, private command: (direction: 'next' | 'prev') => void | Promise<void>,
    private hosts: () => string[] = () => Object.values(networkInterfaces()).flatMap(items => (items ?? [])
      .filter(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')).map(item => item.address)),
    private bindHost = '0.0.0.0', private storage?: MobileClickerStorage) {}

  status(): MobileClickerStatus {
    this.expireDirect()
    return { ...this.state, urls: [...this.state.urls], online: this.access.online, publicUrl: this.access.publicUrl,
      guestOpen: this.access.guestOpen === true, guestPresentations: this.access.guestPresentations === null ? null : [...(this.access.guestPresentations ?? [])],
      target: this.server && this.cloudServer ? 'http://127.0.0.1:' + this.cloudPort : '',
      grants: this.access.grants.map(({ key: _key, ...g }) => ({ ...g, presentations: g.presentations && [...g.presentations] })),
      clients: [...this.clients.values()].map(c => {
        const scope = this.direct.get(c.grantId)?.grant.presentations
        return { ...c, ...(c.direct ? { presentations: scope === null ? null : [...(scope ?? [])] } : {}) }
      }) }
  }
  async qr(index: number): Promise<string | null> {
    const url = Number.isInteger(index) ? this.state.urls[index] : null
    return url ? QRCode.toDataURL(url, { width: 400, margin: 4, errorCorrectionLevel: 'H' }) : null
  }

  setEnabled(enabled?: boolean): Promise<MobileClickerStatus> {
    const operation = this.serial.then(async () => {
      if (!this.loaded) {
        const saved = await this.storage?.load()
        if (saved) { this.key = saved.key; this.port = saved.port; this.cloudPort = saved.cloudPort ?? 0; this.savedEnabled = saved.enabled; if (saved.access) this.access = saved.access }
        this.loaded = true
      }
      const active = enabled ?? this.savedEnabled
      if (this.server) {
        if (!active) { this.state.enabled = false; this.generation++ }
        await this.persist(this.key, active)
        this.generation++; this.state.enabled = active; return this.status()
      }
      if (!active && !this.port) return this.status()
      if (!this.key) this.key = randomBytes(32).toString('base64url')
      this.updatePage()
      const makeServer = (cloud: boolean) => {
        const instance = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, (request, response) => { void this.handle(request, response, cloud).catch(() => this.reply(response, 500, { error: 'Command failed' })) })
        instance.headersTimeout = 5000; instance.requestTimeout = 5000
        instance.maxConnections = 32; instance.keepAliveTimeout = 1000; instance.maxRequestsPerSocket = 40
        instance.setTimeout(5000, socket => socket.destroy())
        instance.on('connection', socket => { socket.setTimeout(5000, () => socket.destroy()) })
        return instance
      }
      const server = makeServer(false)
      this.server = server
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.port, this.bindHost, () => { server.removeListener('error', reject); resolve() }) })
        const address = server.address()
        if (!address || typeof address === 'string') throw Error('No listening address')
        this.port = address.port
        const cloud = makeServer(true); this.cloudServer = cloud
        await new Promise<void>((resolve, reject) => { cloud.once('error', reject); cloud.listen(this.cloudPort, '127.0.0.1', () => { cloud.removeListener('error', reject); resolve() }) })
        this.cloudPort = (cloud.address() as import('node:net').AddressInfo).port
        cloud.on('error', () => { this.state.error = t('Ошибка сервера мобильного кликера') })
        await this.persist(this.key, active)
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
      await this.persist(newKey, this.state.enabled, { ...this.access, grants: [] })
      this.key = newKey; this.access.grants = []; this.clients.clear(); this.direct.clear()
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
    this.direct.clear(); this.clients.clear()
    const server = this.server; this.server = null
    const cloud = this.cloudServer; this.cloudServer = null
    this.state = { enabled: false, urls: [], qr: null, error: null }
    if (cloud) await new Promise<void>(resolve => { cloud.close(() => resolve()); cloud.closeAllConnections() })
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }

  private reply(response: ServerResponse, status: number, data: unknown): void {
    if (response.destroyed || response.writableEnded) return
    if (status === 429) response.setHeader('Retry-After', '1')
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(JSON.stringify(data))
  }

  private async handle(request: IncomingMessage, response: ServerResponse, cloud = false): Promise<void> {
    if (cloud && !this.access.online) { this.reply(response, 403, { error: 'Online mode disabled' }); return }
    // Bound CPU before parsing credentials, rendering HTML or reading bodies. Never trust forwarded IPs.
    for (const [id, bucket] of this.rates) if (Date.now() - bucket.time > 60_000) this.rates.delete(id)
    if (!this.consume(this.globalRate, 80, 120) || this.limited('ip:' + request.socket.remoteAddress, 60, 100)) {
      response.setHeader('Connection', 'close'); this.reply(response, 429, { error: 'Rate limited' }); return
    }
    const pathname = (request.url ?? '').split('?')[0]
    if (cloud && this.probe && Date.now() < this.probe.expires && pathname === '/.well-known/cuedeck-clicker/' + this.probe.nonce && request.method === 'GET') {
      this.reply(response, 200, { nonce: this.probe.nonce }); return
    }
    const origin = request.headers.origin
    const publicOrigin = cloud && this.access.online ? this.access.publicUrl : ''
    const localOrigins = this.state.urls.map(url => new URL(url).origin).concat('http://127.0.0.1:' + this.port, 'http://localhost:' + this.port, 'http://127.0.0.1:' + this.cloudPort, 'http://localhost:' + this.cloudPort)
    // A public Host is not accepted until online mode is explicitly configured.
    const host = request.headers.host ?? ''
    if (![...localOrigins, ...(publicOrigin ? [publicOrigin] : [])].some(value => new URL(value).host === host)) { this.reply(response, 403, { error: 'Wrong host' }); return }
    if (origin && (cloud ? origin !== publicOrigin : !localOrigins.includes(origin))) { this.reply(response, 403, { error: 'Wrong origin' }); return }
    if (pathname === '/' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${this.pageHash}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, 'X-Content-Type-Options': 'nosniff' })
      response.end(this.page); return
    }
    if (pathname === '/join' && request.method === 'POST') {
      await this.join(request, response, cloud); return
    }
    this.expireDirect()
    const raw = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
    const token = Buffer.from(raw)
    const matches = (value: string) => { const expected = Buffer.from(value); return expected.length > 0 && token.length === expected.length && timingSafeEqual(token, expected) }
    const persistent = this.access.grants.find(g => matches(g.key))
    const direct = persistent ? undefined : [...this.direct.values()].find(s => matches(s.grant.key))
    const grant = persistent ?? direct?.grant
    // The legacy LAN key must never authorize requests through an online tunnel, even if it rewrites Host.
    if (!grant && (this.access.online || !matches(this.key))) { this.reply(response, 401, { error: 'Unauthorized' }); return }
    const clientId = request.headers['x-clicker-client']
    if (grant && (typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(clientId))) { this.reply(response, 400, { error: 'Client identity required' }); return }
    if (direct && direct.clientId !== clientId) { this.reply(response, 401, { error: 'Unauthorized' }); return }
    const identity = grant ? grant.id + ':' + clientId : 'legacy'
    let client = this.clients.get(identity)
    if (grant && !client) {
      if (this.clients.size >= 128 || [...this.clients.values()].filter(c => c.grantId === grant.id).length >= 16) { this.reply(response, 429, { error: 'Client limit' }); return }
      client = { id: identity, grantId: grant.id, name: grant.name, lastSeen: Date.now(), pending: true, blocked: true }; this.clients.set(identity, client)
    }
    if (client) client.lastSeen = Date.now()
    if (this.limited('grant:' + (grant?.id ?? 'legacy'), 12, 24) || this.limited('client:' + identity, 5, 12)) { this.reply(response, 429, { error: 'Rate limited' }); return }
    const snapshot = this.snapshot()
    const permitted = this.allowed(grant, snapshot) && !client?.blocked
    if (pathname === '/state' && request.method === 'GET') {
      const visible = permitted ? snapshot : { current: 0, total: 0, remaining: 0, canNavigate: false, timer: { text: '--:--', color: 'neutral' } }
      // No filesystem paths, playlist IDs or capability secrets are sent to browsers.
      const { presentationId: _id, ...safe } = visible as MobileClickerSnapshot
      this.reply(response, 200, { ...safe, enabled: this.state.enabled && permitted,
        ...(grant ? { access: client?.blocked ? 'approval' : !permitted ? 'presentation' : 'allowed' } : {}) }); return
    }
    if (pathname !== '/command' || request.method !== 'POST') { this.reply(response, 404, { error: 'Not found' }); return }
    if (!this.state.enabled || !permitted || !snapshot.canNavigate) { this.reply(response, 403, { error: 'Clicker unavailable' }); return }
    // Count from the beginning of a body read, not after JSON parsing. No command queue.
    if (this.pending >= 1) { this.reply(response, 429, { error: 'Busy' }); return }
    this.pending++
    const generation = this.generation
    try {
      if (Number(request.headers['content-length'] ?? 0) > 2048) { response.setHeader('Connection', 'close'); this.reply(response, 413, { error: 'Too large' }); return }
      let body = ''; let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 2048) { response.setHeader('Connection', 'close'); this.reply(response, 413, { error: 'Too large' }); return }
        body += chunk.toString()
      }
      let payload: { direction?: unknown; id?: unknown }
      try { payload = JSON.parse(body) } catch { this.reply(response, 400, { error: 'Invalid command' }); return }
      if (!payload || Array.isArray(payload) || (payload.direction !== 'next' && payload.direction !== 'prev') || typeof payload.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.id)) { this.reply(response, 400, { error: 'Invalid command' }); return }
      const id = identity + ':' + payload.id
      for (const [id, timestamp] of this.seen) if (Date.now() - timestamp > 60_000) this.seen.delete(id)
      if (this.seen.has(id)) { this.reply(response, 200, { ok: true }); return }
      if (!this.consume(this.commandRate, 4, 4)) { this.reply(response, 429, { error: 'Busy' }); return }
      this.expireDirect()
      const fresh = this.snapshot()
      if (generation !== this.generation || !this.state.enabled || client?.blocked || !this.allowed(grant, fresh) || !fresh.canNavigate || snapshot.presentationId !== fresh.presentationId) { this.reply(response, 403, { error: 'Clicker unavailable' }); return }
      this.seen.set(id, Date.now())
      while (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value!)
      await this.command(payload.direction)
      this.reply(response, 200, { ok: true })
    } finally { this.pending-- }
  }

  private async join(request: IncomingMessage, response: ServerResponse, cloud: boolean): Promise<void> {
    this.expireDirect()
    const clientId = request.headers['x-clicker-client']
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(clientId)) { this.reply(response, 400, { error: 'Client identity required' }); return }
    if (this.joining >= 2 || this.direct.size >= 64 || this.clients.size >= 128 || [...this.direct.values()].filter(s => !s.approved).length >= 16 || !this.consume(this.joinRate, 0.5, 4)) {
      this.reply(response, 429, { error: 'Join limit' }); return
    }
    this.joining++
    const generation = this.generation
    try {
      let body = ''; let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 512) { response.setHeader('Connection', 'close'); this.reply(response, 413, { error: 'Too large' }); return }
        body += chunk.toString()
      }
      let name: unknown
      try { name = JSON.parse(body).name } catch { this.reply(response, 400, { error: 'Invalid request' }); return }
      if (typeof name !== 'string' || name.trim().length > 80) { this.reply(response, 400, { error: 'Invalid name' }); return }
      if (generation !== this.generation || (cloud && !this.access.online)) { this.reply(response, 403, { error: 'Online mode disabled' }); return }
      if (this.direct.size >= 64 || this.clients.size >= 128 || [...this.direct.values()].filter(s => !s.approved).length >= 16) { this.reply(response, 429, { error: 'Join limit' }); return }
      const open = this.access.guestOpen === true
      const scope = this.access.guestPresentations === null ? null : [...(this.access.guestPresentations ?? [])]
      const grant: ClickerGrant = { id: randomBytes(16).toString('hex'), key: randomBytes(32).toString('base64url'), name: name.trim() || t('Гость CLOUDPUB'), presentations: open ? scope : [] }
      this.direct.set(grant.id, { grant, expires: Date.now() + (open ? 12 * 60 * 60 * 1000 : 120000), approved: open, clientId })
      const identity = grant.id + ':' + clientId
      this.clients.set(identity, { id: identity, grantId: grant.id, name: grant.name, lastSeen: Date.now(), pending: !open, blocked: !open, direct: true })
      this.reply(response, 200, { key: grant.key })
    } finally { this.joining-- }
  }
}
