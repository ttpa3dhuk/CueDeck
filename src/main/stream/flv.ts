import { encodeEcmaArray, encodeValues } from './amf0.js'

/**
 * Тела сообщений RTMP в формате тегов FLV (то, что лежит в FLV-файле после
 * 11-байтного заголовка тега). WebCodecs отдаёт H.264 в формате `avc`
 * (NALU с 4-байтной длиной) и AVCDecoderConfigurationRecord — ровно то, что
 * FLV ждёт; AAC — сырые кадры и AudioSpecificConfig. Перепаковки нет.
 */

/** AVC sequence header: AVCDecoderConfigurationRecord из decoderConfig.description. */
export function videoSequenceHeader(avcC: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x17, 0x00, 0, 0, 0]), avcC])
}

/**
 * Кадр H.264. Без B-кадров (latencyMode 'realtime'), поэтому composition
 * time всегда 0.
 */
export function videoFrame(data: Buffer, key: boolean): Buffer {
  return Buffer.concat([Buffer.from([key ? 0x17 : 0x27, 0x01, 0, 0, 0]), data])
}

/** Конец потока — вежливое прощание перед закрытием. */
export function videoEndOfSequence(): Buffer {
  return Buffer.from([0x17, 0x02, 0, 0, 0])
}

// 0xAF = AAC | 44 кГц | 16 бит | стерео — по спецификации FLV для AAC всегда так,
// настоящие параметры декодер берёт из AudioSpecificConfig.
const AAC = 0xaf

export function audioSequenceHeader(asc: Buffer): Buffer {
  return Buffer.concat([Buffer.from([AAC, 0x00]), asc])
}

export function audioFrame(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([AAC, 0x01]), data])
}

export interface StreamMeta {
  width: number
  height: number
  fps: number
  videoKbps: number
  audioKbps: number
  sampleRate: number
  channels: number
}

/** `@setDataFrame onMetaData` — площадки показывают по нему параметры потока. */
export function metaData(m: StreamMeta): Buffer {
  return Buffer.concat([
    encodeValues(['@setDataFrame', 'onMetaData']),
    encodeEcmaArray({
      duration: 0,
      width: m.width,
      height: m.height,
      videodatarate: m.videoKbps,
      framerate: m.fps,
      videocodecid: 7,
      audiodatarate: m.audioKbps,
      audiosamplerate: m.sampleRate,
      audiosamplesize: 16,
      stereo: m.channels > 1,
      audiocodecid: 10,
      encoder: 'CueDeck',
      filesize: 0,
    }),
  ])
}
