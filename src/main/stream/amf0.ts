/**
 * AMF0 — формат команд RTMP (connect, publish, onStatus) и метаданных FLV.
 * Ровно то подмножество, что нужно издателю потока: числа, строки, булевы,
 * null/undefined, объекты и ECMA-массивы. Без зависимостей — покрыт
 * tests/stream-rtmp.test.ts.
 */

export type Amf0Value = number | string | boolean | null | undefined | Amf0Object
export interface Amf0Object {
  [key: string]: Amf0Value
}

const NUMBER = 0x00
const BOOLEAN = 0x01
const STRING = 0x02
const OBJECT = 0x03
const NULL = 0x05
const UNDEFINED = 0x06
const ECMA_ARRAY = 0x08
const OBJECT_END = 0x09
const STRICT_ARRAY = 0x0a
const DATE = 0x0b
const LONG_STRING = 0x0c

function utf8Key(key: string): Buffer {
  const b = Buffer.from(key, 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(b.length)
  return Buffer.concat([len, b])
}

function encodeProps(obj: Amf0Object): Buffer[] {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(obj)) {
    parts.push(utf8Key(k), encodeValue(v))
  }
  parts.push(Buffer.from([0x00, 0x00, OBJECT_END]))
  return parts
}

export function encodeValue(v: Amf0Value): Buffer {
  if (v === null) return Buffer.from([NULL])
  if (v === undefined) return Buffer.from([UNDEFINED])
  if (typeof v === 'number') {
    const b = Buffer.alloc(9)
    b[0] = NUMBER
    b.writeDoubleBE(v, 1)
    return b
  }
  if (typeof v === 'boolean') return Buffer.from([BOOLEAN, v ? 1 : 0])
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8')
    if (s.length > 0xffff) {
      const h = Buffer.alloc(5)
      h[0] = LONG_STRING
      h.writeUInt32BE(s.length, 1)
      return Buffer.concat([h, s])
    }
    const h = Buffer.alloc(3)
    h[0] = STRING
    h.writeUInt16BE(s.length, 1)
    return Buffer.concat([h, s])
  }
  return Buffer.concat([Buffer.from([OBJECT]), ...encodeProps(v)])
}

/** ECMA-массив — так ждут onMetaData площадки (YouTube, VK). */
export function encodeEcmaArray(obj: Amf0Object): Buffer {
  const h = Buffer.alloc(5)
  h[0] = ECMA_ARRAY
  h.writeUInt32BE(Object.keys(obj).length, 1)
  return Buffer.concat([h, ...encodeProps(obj)])
}

export function encodeValues(values: Amf0Value[]): Buffer {
  return Buffer.concat(values.map(encodeValue))
}

/** Разбор ответа сервера. Незнакомый тип обрывает разбор — хватает того, что прочитано. */
export function decodeValues(buf: Buffer): Amf0Value[] {
  const out: Amf0Value[] = []
  let pos = 0

  const readString = (): string => {
    const len = buf.readUInt16BE(pos)
    pos += 2
    const s = buf.toString('utf8', pos, pos + len)
    pos += len
    return s
  }

  const readProps = (): Amf0Object => {
    const obj: Amf0Object = {}
    while (pos + 3 <= buf.length) {
      if (buf.readUInt16BE(pos) === 0 && buf[pos + 2] === OBJECT_END) {
        pos += 3
        break
      }
      const k = readString()
      obj[k] = readValue()
    }
    return obj
  }

  const readValue = (): Amf0Value => {
    const type = buf[pos++]
    switch (type) {
      case NUMBER: {
        const n = buf.readDoubleBE(pos)
        pos += 8
        return n
      }
      case BOOLEAN:
        return buf[pos++] !== 0
      case STRING:
        return readString()
      case LONG_STRING: {
        const len = buf.readUInt32BE(pos)
        pos += 4
        const s = buf.toString('utf8', pos, pos + len)
        pos += len
        return s
      }
      case OBJECT:
        return readProps()
      case ECMA_ARRAY:
        pos += 4
        return readProps()
      case STRICT_ARRAY: {
        const n = buf.readUInt32BE(pos)
        pos += 4
        const arr: Amf0Object = {}
        for (let i = 0; i < n; i++) arr[String(i)] = readValue()
        return arr
      }
      case DATE: {
        const n = buf.readDoubleBE(pos)
        pos += 10
        return n
      }
      case NULL:
        return null
      case UNDEFINED:
        return undefined
      default:
        throw new Error(`AMF0 type ${type}`)
    }
  }

  try {
    while (pos < buf.length) out.push(readValue())
  } catch {
    /* обрыв на незнакомом типе — отдаём прочитанное */
  }
  return out
}
