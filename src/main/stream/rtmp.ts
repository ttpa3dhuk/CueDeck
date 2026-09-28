import { createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'
import { decodeValues, encodeValues, type Amf0Object, type Amf0Value } from './amf0.js'
import { t } from '../../shared/i18n.js'

/**
 * Издатель RTMP/RTMPS — ровно столько протокола, сколько нужно, чтобы
 * отдать поток площадке (YouTube, VK, Rutube, Telegram…). Без зависимостей.
 *
 * Порядок: рукопожатие (C1 с подписью HMAC, как у ffmpeg — площадки его
 * принимают) → Set Chunk Size → connect → releaseStream / FCPublish /
 * createStream → publish → ждём NetStream.Publish.Start → медиа.
 * Входящие сообщения разбираются полностью (чанки, расширенные метки времени),
 * отвечаем на ping и подтверждаем принятые байты — иначе сервер рвёт связь.
 */

export interface RtmpTarget {
  secure: boolean
  host: string
  port: number
  app: string
  tcUrl: string
  streamName: string
}

/**
 * «Сервер» + «ключ», как их выдают площадки. Ключ пустой — значит, его
 * вставили в адрес целиком: последний сегмент пути и есть ключ.
 */
export function parseRtmpUrl(url: string, key: string): RtmpTarget | null {
  const raw = url.trim()
  const m = /^(rtmps?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(raw)
  if (!m) return null
  const secure = m[1].toLowerCase() === 'rtmps'
  const hostPort = m[2]
  const hp = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(hostPort)
  if (!hp) return null
  const host = hp[1]
  const port = hp[2] ? Number(hp[2]) : secure ? 443 : 1935
  let segments = (m[3] ?? '').split('/').filter(Boolean)
  let name = key.trim().replace(/^\/+/, '')
  if (!name) {
    if (segments.length < 2) return null
    name = segments[segments.length - 1] + (m[4] ?? '')
    segments = segments.slice(0, -1)
  }
  if (!segments.length || !name) return null
  const app = segments.join('/') + (key.trim() ? m[4] ?? '' : '')
  const tcUrl = `${m[1].toLowerCase()}://${hostPort}/${app}`
  return { secure, host, port, app, tcUrl, streamName: name }
}

// ── рукопожатие ─────────────────────────────────────────────────────────────

const HANDSHAKE_SIZE = 1536
// «Genuine Adobe Flash Player 001» — первые 30 байт ключа клиента (как у ffmpeg).
const FP_KEY = Buffer.from('Genuine Adobe Flash Player 001', 'ascii')

/** C1 с подписью: так рукопожатие проходят и «строгие» серверы. */
export function makeC1(): Buffer {
  const c1 = randomBytes(HANDSHAKE_SIZE)
  c1.writeUInt32BE(0, 0) // время
  c1[4] = 9 // версия клиента 9.0.124.2 — как ffmpeg
  c1[5] = 0
  c1[6] = 124
  c1[7] = 2
  const pos = ((c1[8] + c1[9] + c1[10] + c1[11]) % 728) + 12
  const msg = Buffer.concat([c1.subarray(0, pos), c1.subarray(pos + 32)])
  createHmac('sha256', FP_KEY).update(msg).digest().copy(c1, pos)
  return c1
}

// ── чанки ───────────────────────────────────────────────────────────────────

const OUT_CHUNK_SIZE = 4096

const MSG_SET_CHUNK_SIZE = 1
const MSG_ACK = 3
const MSG_USER_CONTROL = 4
const MSG_WINDOW_ACK = 5
const MSG_PEER_BW = 6
const MSG_AUDIO = 8
const MSG_VIDEO = 9
const MSG_DATA = 18
const MSG_COMMAND = 20

const CSID_CONTROL = 2
const CSID_COMMAND = 3
/**
 * Звук, видео и метаданные — одним chunk stream, как у OBS (librtmp) и ffmpeg.
 * Telegram (rtmps://…rtmp.t.me) медиа из разных каналов не собирает: соединение
 * есть, байты подтверждаются, а зрителям — серая заглушка (LESSONS 2026-09-29).
 */
const CSID_MEDIA = 4

/** Сообщение → чанки (заголовок fmt 0, дальше fmt 3). */
export function encodeMessage(
  csid: number,
  type: number,
  streamId: number,
  timestamp: number,
  payload: Buffer,
  chunkSize = OUT_CHUNK_SIZE,
): Buffer {
  const ts = timestamp >>> 0
  const ext = ts >= 0xffffff
  const head = Buffer.alloc(12 + (ext ? 4 : 0))
  head[0] = csid & 0x3f
  head.writeUIntBE(ext ? 0xffffff : ts, 1, 3)
  head.writeUIntBE(payload.length, 4, 3)
  head[7] = type
  head.writeUInt32LE(streamId, 8)
  if (ext) head.writeUInt32BE(ts, 12)
  const parts: Buffer[] = [head]
  const cont = Buffer.alloc(1 + (ext ? 4 : 0))
  cont[0] = 0xc0 | (csid & 0x3f)
  if (ext) cont.writeUInt32BE(ts, 1)
  for (let off = 0; off < payload.length; off += chunkSize) {
    if (off > 0) parts.push(cont)
    parts.push(payload.subarray(off, Math.min(off + chunkSize, payload.length)))
  }
  return Buffer.concat(parts)
}

interface InChunkStream {
  timestamp: number
  delta: number
  length: number
  type: number
  streamId: number
  extended: boolean
  body: Buffer[]
  received: number
}

export interface RtmpMessage {
  type: number
  streamId: number
  timestamp: number
  payload: Buffer
}

/** Разбор входящего потока чанков; копит байты, отдаёт целые сообщения. */
export class ChunkReader {
  chunkSize = 128
  private buf: Buffer = Buffer.alloc(0)
  private streams = new Map<number, InChunkStream>()

  push(data: Buffer): RtmpMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    const out: RtmpMessage[] = []
    for (;;) {
      const r = this.readChunk()
      if (r === null) break
      if (r !== undefined) out.push(r)
    }
    return out
  }

  /** null — байт не хватает; undefined — чанк прочитан, сообщение ещё не собрано. */
  private readChunk(): RtmpMessage | null | undefined {
    const b = this.buf
    if (b.length < 1) return null
    let p = 0
    const fmt = b[0] >> 6
    let csid = b[0] & 0x3f
    p = 1
    if (csid === 0) {
      if (b.length < 2) return null
      csid = b[1] + 64
      p = 2
    } else if (csid === 1) {
      if (b.length < 3) return null
      csid = b[1] + b[2] * 256 + 64
      p = 3
    }
    const hsize = [11, 7, 3, 0][fmt]
    if (b.length < p + hsize) return null
    let st = this.streams.get(csid)
    if (!st) {
      st = { timestamp: 0, delta: 0, length: 0, type: 0, streamId: 0, extended: false, body: [], received: 0 }
    }
    const next = { ...st }
    let tsField = 0
    if (fmt <= 2) tsField = b.readUIntBE(p, 3)
    if (fmt <= 1) {
      next.length = b.readUIntBE(p + 3, 3)
      next.type = b[p + 6]
    }
    if (fmt === 0) next.streamId = b.readUInt32LE(p + 7)
    p += hsize
    let ext = false
    if (fmt <= 2) ext = tsField === 0xffffff
    else ext = st.extended
    let extTs = 0
    if (ext) {
      if (b.length < p + 4) return null
      extTs = b.readUInt32BE(p)
      p += 4
    }
    const fresh = st.received === 0
    if (fmt <= 2) {
      const v = ext ? extTs : tsField
      next.extended = ext
      if (fmt === 0) {
        next.timestamp = v
        next.delta = 0
      } else {
        next.delta = v
        next.timestamp = (st.timestamp + v) >>> 0
      }
    } else if (fresh) {
      // fmt 3 в начале нового сообщения — повтор предыдущей дельты.
      next.timestamp = (st.timestamp + st.delta) >>> 0
    }
    const want = Math.min(this.chunkSize, next.length - next.received)
    if (b.length < p + want) return null
    next.body = fresh ? [] : st.body
    next.body.push(b.subarray(p, p + want))
    next.received = (fresh ? 0 : st.received) + want
    this.buf = b.subarray(p + want)
    if (next.received >= next.length) {
      const msg: RtmpMessage = {
        type: next.type,
        streamId: next.streamId,
        timestamp: next.timestamp,
        payload: Buffer.concat(next.body),
      }
      next.body = []
      next.received = 0
      this.streams.set(csid, next)
      if (msg.type === MSG_SET_CHUNK_SIZE && msg.payload.length >= 4) {
        this.chunkSize = msg.payload.readUInt32BE(0) & 0x7fffffff
      }
      return msg
    }
    this.streams.set(csid, next)
    return undefined
  }
}

// ── издатель ────────────────────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 15_000

export interface PublisherStats {
  bytesSent: number
  dropped: number
  framesSent: number
  /** Байт, которые сервер подтвердил (Acknowledgement); null — не присылал. */
  acked: number | null
}

/**
 * Одно соединение с одной площадкой. События: 'close' (err?: string) —
 * соединение закончилось (ошибкой или по close()).
 */
export class RtmpPublisher extends EventEmitter {
  readonly stats: PublisherStats = { bytesSent: 0, dropped: 0, framesSent: 0, acked: null }
  private sock: net.Socket | null = null
  private reader = new ChunkReader()
  private streamId = 0
  private txn = 0
  private pending = new Map<number, { resolve: (v: Amf0Value[]) => void; reject: (e: Error) => void }>()
  private publishWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null
  private windowAck = 2_500_000
  private received = 0
  private lastAck = 0
  private closed = false
  /** Сеть не успевает — пропускаем видео до следующего ключевого кадра. */
  private waitKey = false

  constructor(private readonly target: RtmpTarget) {
    super()
  }

  /** Сколько байт ждёт отправки в сокете — мерило «сеть не успевает». */
  get backlog(): number {
    return this.sock?.writableLength ?? 0
  }

  async connect(): Promise<void> {
    const sock = await this.openSocket()
    this.sock = sock
    await this.handshake(sock)
    sock.on('data', (d: Buffer) => this.onData(d))
    sock.on('error', (e) => this.finish(e.message))
    sock.on('close', () => this.finish(this.closed ? undefined : t('Площадка закрыла соединение')))

    const setChunk = Buffer.alloc(4)
    setChunk.writeUInt32BE(OUT_CHUNK_SIZE)
    this.write(encodeMessage(CSID_CONTROL, MSG_SET_CHUNK_SIZE, 0, 0, setChunk, 128))

    const { app, tcUrl, streamName } = this.target
    await this.withTimeout(
      this.command('connect', {
        app,
        type: 'nonprivate',
        flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
        swfUrl: tcUrl,
        tcUrl,
      }),
    )
    this.commandNoWait('releaseStream', null, streamName)
    this.commandNoWait('FCPublish', null, streamName)
    const created = await this.withTimeout(this.command('createStream', null))
    this.streamId = typeof created[1] === 'number' ? created[1] : 1

    const started = new Promise<void>((resolve, reject) => {
      this.publishWaiter = { resolve, reject }
    })
    const body = encodeValues(['publish', 0, null, streamName, 'live'])
    this.write(encodeMessage(CSID_COMMAND, MSG_COMMAND, this.streamId, 0, body))
    await this.withTimeout(started)
  }

  sendMeta(payload: Buffer): void {
    this.write(encodeMessage(CSID_MEDIA, MSG_DATA, this.streamId, 0, payload))
  }

  /**
   * `maxBacklog` — сколько байт может копиться в сокете, пока сеть не успевает.
   * Сверх — выбрасываем видео до следующего ключевого кадра (звук держим
   * дольше: без картинки смотреть можно, с дырами в звуке — нет).
   */
  sendVideo(ts: number, payload: Buffer, key: boolean, maxBacklog: number, force = false): void {
    if (!force) {
      if (this.backlog > maxBacklog * (key ? 2 : 1)) {
        this.waitKey = true
        this.stats.dropped++
        return
      }
      if (this.waitKey && !key) {
        this.stats.dropped++
        return
      }
    }
    this.waitKey = false
    this.stats.framesSent++
    this.write(encodeMessage(CSID_MEDIA, MSG_VIDEO, this.streamId, ts, payload))
  }

  sendAudio(ts: number, payload: Buffer, maxBacklog: number, force = false): void {
    if (!force && this.backlog > maxBacklog * 3) return
    this.write(encodeMessage(CSID_MEDIA, MSG_AUDIO, this.streamId, ts, payload))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const sock = this.sock
    if (sock && !sock.destroyed) {
      try {
        if (this.streamId) {
          this.write(encodeMessage(CSID_COMMAND, MSG_COMMAND, 0, 0, encodeValues(['FCUnpublish', ++this.txn, null, this.target.streamName])))
          this.write(encodeMessage(CSID_COMMAND, MSG_COMMAND, 0, 0, encodeValues(['deleteStream', ++this.txn, null, this.streamId])))
        }
        sock.end()
      } catch {
        /* уже рвётся */
      }
      setTimeout(() => sock.destroy(), 1000)
    }
    this.finish(undefined)
  }

  // ── внутреннее ──

  private openSocket(): Promise<net.Socket> {
    const { host, port, secure } = this.target
    return new Promise((resolve, reject) => {
      const onErr = (e: Error): void => {
        clearTimeout(timer)
        reject(e)
      }
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error(t('Сервер не отвечает')))
      }, CONNECT_TIMEOUT_MS)
      const ready = (): void => {
        clearTimeout(timer)
        sock.off('error', onErr)
        sock.setNoDelay(true)
        resolve(sock)
      }
      const sock: net.Socket = secure
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }, ready)
        : net.connect({ host, port }, ready)
      sock.once('error', onErr)
    })
  }

  private handshake(sock: net.Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      let acc = Buffer.alloc(0)
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(t('Сервер не отвечает')))
      }, CONNECT_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timer)
        sock.off('data', onData)
        sock.off('error', onErr)
        sock.off('close', onClose)
      }
      const onErr = (e: Error): void => {
        cleanup()
        reject(e)
      }
      const onClose = (): void => {
        cleanup()
        reject(new Error(t('Площадка закрыла соединение')))
      }
      const onData = (d: Buffer): void => {
        acc = Buffer.concat([acc, d])
        if (acc.length < 1 + 2 * HANDSHAKE_SIZE) return
        cleanup()
        if (acc[0] !== 3) {
          reject(new Error(t('Это не RTMP-сервер')))
          return
        }
        const s1 = acc.subarray(1, 1 + HANDSHAKE_SIZE)
        // C2 = эхо S1 — так делает ffmpeg при публикации.
        sock.write(s1)
        const rest = acc.subarray(1 + 2 * HANDSHAKE_SIZE)
        if (rest.length) setImmediate(() => this.onData(rest))
        resolve()
      }
      sock.on('data', onData)
      sock.on('error', onErr)
      sock.on('close', onClose)
      sock.write(Buffer.concat([Buffer.from([3]), makeC1()]))
    })
  }

  private write(buf: Buffer): void {
    const sock = this.sock
    if (!sock || sock.destroyed) return
    this.stats.bytesSent += buf.length
    sock.write(buf)
  }

  private command(name: string, obj: Amf0Object | null, ...args: Amf0Value[]): Promise<Amf0Value[]> {
    const id = ++this.txn
    const p = new Promise<Amf0Value[]>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.write(encodeMessage(CSID_COMMAND, MSG_COMMAND, 0, 0, encodeValues([name, id, obj, ...args])))
    return p
  }

  private commandNoWait(name: string, obj: Amf0Object | null, ...args: Amf0Value[]): void {
    this.write(encodeMessage(CSID_COMMAND, MSG_COMMAND, 0, 0, encodeValues([name, ++this.txn, obj, ...args])))
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('Площадка не приняла поток: нет ответа'))), CONNECT_TIMEOUT_MS)
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  private onData(d: Buffer): void {
    this.received += d.length
    if (this.received - this.lastAck >= this.windowAck) {
      this.lastAck = this.received
      const b = Buffer.alloc(4)
      b.writeUInt32BE(this.received >>> 0)
      this.write(encodeMessage(CSID_CONTROL, MSG_ACK, 0, 0, b, OUT_CHUNK_SIZE))
    }
    let msgs: RtmpMessage[]
    try {
      msgs = this.reader.push(d)
    } catch {
      this.finish(t('Площадка прислала непонятный ответ'))
      return
    }
    for (const m of msgs) this.onMessage(m)
  }

  private onMessage(m: RtmpMessage): void {
    switch (m.type) {
      case MSG_ACK:
        if (m.payload.length >= 4) this.stats.acked = m.payload.readUInt32BE(0)
        break
      case MSG_WINDOW_ACK:
        if (m.payload.length >= 4) this.windowAck = m.payload.readUInt32BE(0)
        break
      case MSG_PEER_BW:
        if (m.payload.length >= 4) {
          const b = Buffer.alloc(4)
          b.writeUInt32BE(m.payload.readUInt32BE(0))
          this.write(encodeMessage(CSID_CONTROL, MSG_WINDOW_ACK, 0, 0, b))
        }
        break
      case MSG_USER_CONTROL:
        // PingRequest (6) → PingResponse (7) с тем же временем.
        if (m.payload.length >= 6 && m.payload.readUInt16BE(0) === 6) {
          const b = Buffer.alloc(6)
          b.writeUInt16BE(7, 0)
          m.payload.copy(b, 2, 2, 6)
          this.write(encodeMessage(CSID_CONTROL, MSG_USER_CONTROL, 0, 0, b))
        }
        break
      case MSG_COMMAND:
        this.onCommand(decodeValues(m.payload))
        break
    }
  }

  private onCommand(v: Amf0Value[]): void {
    const [name, id] = v
    if (name === '_result' || name === '_error') {
      const p = typeof id === 'number' ? this.pending.get(id) : undefined
      if (!p) return
      this.pending.delete(id as number)
      if (name === '_result') p.resolve(v.slice(2))
      else p.reject(new Error(describeStatus(v[3]) ?? t('Площадка отказала в подключении')))
      return
    }
    if (name === 'onStatus') {
      const info = v[3]
      const code = info && typeof info === 'object' ? String(info.code ?? '') : ''
      const level = info && typeof info === 'object' ? String(info.level ?? '') : ''
      if (code === 'NetStream.Publish.Start') {
        this.publishWaiter?.resolve()
        this.publishWaiter = null
      } else if (level === 'error' || /Failed|BadName|Rejected/i.test(code)) {
        const err = describeStatus(info) ?? code
        if (this.publishWaiter) {
          this.publishWaiter.reject(new Error(err))
          this.publishWaiter = null
        } else {
          this.finish(err)
        }
      }
    }
  }

  private finished = false

  private finish(err: string | undefined): void {
    if (this.finished) return
    this.finished = true
    const e = new Error(err ?? t('Соединение закрыто'))
    for (const p of this.pending.values()) p.reject(e)
    this.pending.clear()
    this.publishWaiter?.reject(e)
    this.publishWaiter = null
    if (this.sock && !this.sock.destroyed && err) this.sock.destroy()
    this.emit('close', err)
  }
}

/** Понятная оператору причина из объекта onStatus/_error. */
function describeStatus(info: Amf0Value): string | null {
  if (!info || typeof info !== 'object') return null
  const code = String(info.code ?? '')
  const desc = typeof info.description === 'string' ? info.description : ''
  if (/BadName|Publish\.Denied|Rejected|Unauthorized|auth/i.test(code + ' ' + desc)) {
    return t('Площадка не приняла ключ потока — проверь ключ и что трансляция создана') + (desc ? ` (${desc})` : '')
  }
  return desc || code || null
}
