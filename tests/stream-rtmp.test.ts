import { describe, expect, it } from 'vitest'
import { decodeValues, encodeEcmaArray, encodeValues } from '../src/main/stream/amf0'
import { ChunkReader, encodeMessage, makeC1, parseRtmpUrl } from '../src/main/stream/rtmp'
import { audioSequenceHeader, metaData, videoFrame } from '../src/main/stream/flv'

describe('адрес площадки', () => {
  it('сервер + ключ, как выдают YouTube / VK / Telegram', () => {
    expect(parseRtmpUrl('rtmp://a.rtmp.youtube.com/live2', 'abcd-1234')).toEqual({
      secure: false,
      host: 'a.rtmp.youtube.com',
      port: 1935,
      app: 'live2',
      tcUrl: 'rtmp://a.rtmp.youtube.com/live2',
      streamName: 'abcd-1234',
    })
    const tg = parseRtmpUrl('rtmps://dc4-1.rtmp.t.me/s/', '123:ABC')!
    expect(tg.secure).toBe(true)
    expect(tg.port).toBe(443)
    expect(tg.app).toBe('s')
    expect(tg.streamName).toBe('123:ABC')
  })

  it('ключ внутри адреса, свой порт, пробелы', () => {
    const t = parseRtmpUrl('  rtmp://10.0.0.5:1936/live/mykey ', '')!
    expect(t.port).toBe(1936)
    expect(t.app).toBe('live')
    expect(t.streamName).toBe('mykey')
    expect(t.tcUrl).toBe('rtmp://10.0.0.5:1936/live')
  })

  it('мусор → null', () => {
    expect(parseRtmpUrl('http://x/y', 'k')).toBeNull()
    expect(parseRtmpUrl('rtmp://host', '')).toBeNull()
    expect(parseRtmpUrl('rtmp://host/', 'k')).toBeNull()
  })
})

describe('AMF0', () => {
  it('туда и обратно', () => {
    const v = ['connect', 1, { app: 'live', n: 2.5, ok: true, nested: { a: null } }, null, 'ключ']
    expect(decodeValues(encodeValues(v))).toEqual(v)
  })

  it('ECMA-массив читается как объект', () => {
    expect(decodeValues(encodeEcmaArray({ width: 1920, stereo: true }))).toEqual([{ width: 1920, stereo: true }])
  })

  it('onMetaData', () => {
    const [set, name, meta] = decodeValues(
      metaData({ width: 1920, height: 1080, fps: 30, videoKbps: 6000, audioKbps: 160, sampleRate: 48000, channels: 2 }),
    )
    expect(set).toBe('@setDataFrame')
    expect(name).toBe('onMetaData')
    expect(meta).toMatchObject({ width: 1920, height: 1080, framerate: 30, videocodecid: 7, audiocodecid: 10 })
  })
})

describe('чанки', () => {
  it('большое сообщение режется и собирается обратно', () => {
    const payload = Buffer.alloc(10_000, 7)
    const wire = encodeMessage(6, 9, 1, 12345, payload, 4096)
    const r = new ChunkReader()
    r.chunkSize = 4096
    const msgs = r.push(wire)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ type: 9, streamId: 1, timestamp: 12345 })
    expect(msgs[0].payload.equals(payload)).toBe(true)
  })

  it('расширенная метка времени (эфир дольше 4,6 часа)', () => {
    const payload = Buffer.alloc(5000, 1)
    const ts = 0x1234567
    const r = new ChunkReader()
    r.chunkSize = 4096
    const msgs = r.push(encodeMessage(4, 8, 1, ts, payload, 4096))
    expect(msgs[0].timestamp).toBe(ts)
    expect(msgs[0].payload.length).toBe(5000)
  })

  it('байты приходят кусками, Set Chunk Size меняет размер на лету', () => {
    const size = Buffer.alloc(4)
    size.writeUInt32BE(4096)
    const wire = Buffer.concat([
      encodeMessage(2, 1, 0, 0, size, 128),
      encodeMessage(3, 20, 0, 0, encodeValues(['_result', 1, null, { code: 'ok' }]), 4096),
    ])
    const r = new ChunkReader()
    const out = []
    for (let i = 0; i < wire.length; i += 3) out.push(...r.push(wire.subarray(i, i + 3)))
    expect(out.map((m) => m.type)).toEqual([1, 20])
    expect(decodeValues(out[1].payload)[0]).toBe('_result')
  })

  it('fmt 1/2/3 — дельты времени', () => {
    // fmt0 ts=1000, затем fmt2 дельта 40, затем fmt3 — снова +40
    const p = Buffer.from([1, 2, 3])
    const fmt0 = encodeMessage(4, 8, 1, 1000, p, 128)
    const fmt2 = Buffer.concat([Buffer.from([0x80 | 4, 0, 0, 40]), p])
    const fmt3 = Buffer.concat([Buffer.from([0xc0 | 4]), p])
    const r = new ChunkReader()
    const ts = r.push(Buffer.concat([fmt0, fmt2, fmt3])).map((m) => m.timestamp)
    expect(ts).toEqual([1000, 1040, 1080])
  })
})

describe('рукопожатие и FLV', () => {
  it('C1: 1536 байт, версия 9.0.124.2', () => {
    const c1 = makeC1()
    expect(c1.length).toBe(1536)
    expect([...c1.subarray(4, 8)]).toEqual([9, 0, 124, 2])
  })

  it('теги FLV', () => {
    expect([...videoFrame(Buffer.from([9]), true).subarray(0, 2)]).toEqual([0x17, 0x01])
    expect([...videoFrame(Buffer.from([9]), false).subarray(0, 2)]).toEqual([0x27, 0x01])
    expect([...audioSequenceHeader(Buffer.from([0x11, 0x90]))]).toEqual([0xaf, 0x00, 0x11, 0x90])
  })
})
