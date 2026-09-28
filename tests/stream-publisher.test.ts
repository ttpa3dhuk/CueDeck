import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeValues, encodeValues } from '../src/main/stream/amf0'
import { ChunkReader, encodeMessage, RtmpPublisher, type RtmpTarget } from '../src/main/stream/rtmp'

/**
 * Издатель против поддельного сервера: рукопожатие, connect → createStream →
 * publish, потом сервер перестаёт читать — очередь растёт, видео выбрасывается
 * до ключевого кадра. Это то, что оператор видит как «Сеть: канал не успевает».
 */

type Mode = 'ok' | 'badkey'

function fakeServer(mode: Mode): Promise<{ port: number; server: net.Server; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = []
  const server = net.createServer((sock) => {
    sockets.push(sock)
    let hs = Buffer.alloc(0)
    let handshaken = false
    const reader = new ChunkReader()
    const reply = (values: Parameters<typeof encodeValues>[0], streamId = 0): void => {
      sock.write(encodeMessage(3, 20, streamId, 0, encodeValues(values), 128))
    }
    sock.on('data', (d: Buffer) => {
      if (!handshaken) {
        hs = Buffer.concat([hs, d])
        if (hs.length >= 1537 && sock.bytesWritten === 0) {
          sock.write(Buffer.concat([Buffer.from([3]), Buffer.alloc(1536), hs.subarray(1, 1537)]))
        }
        if (hs.length < 1 + 1536 * 2) return
        handshaken = true
        d = hs.subarray(1 + 1536 * 2)
        if (!d.length) return
      }
      for (const m of reader.push(d)) {
        if (m.type !== 20) continue
        const [name, txn] = decodeValues(m.payload)
        if (name === 'connect') reply(['_result', txn as number, null, { code: 'NetConnection.Connect.Success' }])
        if (name === 'createStream') reply(['_result', txn as number, null, 1])
        if (name === 'publish') {
          if (mode === 'badkey') {
            reply(['onStatus', 0, null, { level: 'error', code: 'NetStream.Publish.BadName', description: 'bad key' }], 1)
          } else {
            reply(['onStatus', 0, null, { level: 'status', code: 'NetStream.Publish.Start' }], 1)
            // «Площадка/канал не успевает»: больше не читаем.
            setImmediate(() => sock.pause())
          }
        }
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, server, sockets })))
}

const target = (port: number): RtmpTarget => ({
  secure: false,
  host: '127.0.0.1',
  port,
  app: 'live',
  tcUrl: `rtmp://127.0.0.1:${port}/live`,
  streamName: 'key',
})

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const f of cleanup) f()
  cleanup = []
})

describe('RtmpPublisher против сервера', () => {
  it('подключается и публикует; медленный канал → выбрасывает видео до ключевого кадра', async () => {
    const { port, server, sockets } = await fakeServer('ok')
    const pub = new RtmpPublisher(target(port))
    cleanup.push(() => {
      pub.close()
      sockets.forEach((s) => s.destroy())
      server.close()
    })
    await pub.connect()

    const frame = Buffer.alloc(200_000, 1)
    const maxBacklog = 1_000_000
    // Шлём, пока сокет не упрётся: сервер не читает.
    for (let i = 0; i < 400; i++) pub.sendVideo(i * 33, frame, i % 60 === 0, maxBacklog)
    expect(pub.backlog).toBeGreaterThan(maxBacklog)
    expect(pub.stats.dropped).toBeGreaterThan(0)
    const sent = pub.stats.framesSent
    // Пока очередь стоит — не-ключевые выбрасываются.
    pub.sendVideo(99_000, frame, false, maxBacklog)
    expect(pub.stats.framesSent).toBe(sent)
  })

  it('неверный ключ → понятная ошибка «площадка не приняла ключ»', async () => {
    const { port, server, sockets } = await fakeServer('badkey')
    const pub = new RtmpPublisher(target(port))
    cleanup.push(() => {
      pub.close()
      sockets.forEach((s) => s.destroy())
      server.close()
    })
    await expect(pub.connect()).rejects.toThrow(/stream key|ключ/)
  })
})

describe('RtmpPublisher: каналы медиа', () => {
  it('звук, видео и метаданные идут одним chunk stream — иначе Telegram показывает серую заглушку', () => {
    const pub = new RtmpPublisher(target(1))
    const first: number[] = []
    // Подставной сокет: смотрим только первый байт каждого сообщения (fmt 0 + csid).
    Object.assign(pub as unknown as Record<string, unknown>, {
      sock: { destroyed: false, writableLength: 0, write: (b: Buffer) => first.push(b[0] & 0x3f) },
    })
    pub.sendMeta(Buffer.from([2, 0, 0]))
    pub.sendVideo(0, Buffer.alloc(10), true, 1e9)
    pub.sendAudio(0, Buffer.alloc(10), 1e9)
    expect(first).toHaveLength(3)
    expect(new Set(first).size).toBe(1)
  })
})
