/**
 * Минимальный OSC 1.0 (Open Sound Control) без зависимостей — разбор входящих
 * UDP-пакетов для внешнего управления (remote/server.ts).
 *
 * Поддержано: сообщения и бандлы (`#bundle`, вложенные — рекурсивно),
 * типы аргументов i f d h s S T F N I. Blob (b) и прочая экзотика пропускаются
 * с корректным сдвигом там, где длина известна; на незнакомом теге разбор
 * сообщения останавливается — адрес и уже прочитанные аргументы остаются.
 *
 * Отправляют нам это Companion (Generic OSC), grandMA3, QLab, StageCue, TouchOSC.
 * Encoder здесь для тестов и для будущего OSC-выхода (PLAN 2.18).
 */

export type OscArg = number | string | boolean | null

export interface OscMessage {
  address: string
  args: OscArg[]
}

/** Длина с выравниванием на 4 байта (строки и blob'ы в OSC). */
function pad4(n: number): number {
  return (n + 3) & ~3
}

function readString(buf: Buffer, offset: number): { value: string; next: number } {
  let end = offset
  while (end < buf.length && buf[end] !== 0) end++
  if (end >= buf.length) throw new Error('OSC: строка без завершающего нуля')
  return { value: buf.toString('utf8', offset, end), next: pad4(end + 1) }
}

function parseMessage(buf: Buffer): OscMessage {
  const addr = readString(buf, 0)
  if (!addr.value.startsWith('/')) throw new Error('OSC: адрес должен начинаться с /')
  const out: OscMessage = { address: addr.value, args: [] }
  // Сообщение без тегов типов (старые отправители) — просто адрес.
  if (addr.next >= buf.length) return out
  const tags = readString(buf, addr.next)
  if (!tags.value.startsWith(',')) return out
  let p = tags.next
  for (const tag of tags.value.slice(1)) {
    switch (tag) {
      case 'i':
        out.args.push(buf.readInt32BE(p))
        p += 4
        break
      case 'f':
        out.args.push(buf.readFloatBE(p))
        p += 4
        break
      case 'd':
        out.args.push(buf.readDoubleBE(p))
        p += 8
        break
      case 'h':
        out.args.push(Number(buf.readBigInt64BE(p)))
        p += 8
        break
      case 's':
      case 'S': {
        const s = readString(buf, p)
        out.args.push(s.value)
        p = s.next
        break
      }
      case 'b': {
        const len = buf.readInt32BE(p)
        p = pad4(p + 4 + len)
        break
      }
      case 'T':
        out.args.push(true)
        break
      case 'F':
        out.args.push(false)
        break
      case 'N':
        out.args.push(null)
        break
      case 'I':
        out.args.push(null)
        break
      default:
        // Незнакомый тип: длину не знаем — дальше читать нельзя.
        return out
    }
  }
  return out
}

const BUNDLE_TAG = '#bundle'

/**
 * Пакет → плоский список сообщений (бандлы раскрываются, тайм-теги
 * игнорируются: команды исполняются сразу). Мусор → исключение.
 */
export function parseOscPacket(buf: Buffer): OscMessage[] {
  if (buf.length >= 16 && buf.toString('ascii', 0, 7) === BUNDLE_TAG && buf[7] === 0) {
    const out: OscMessage[] = []
    let p = 16 // '#bundle\0' + 8 байт тайм-тега
    while (p + 4 <= buf.length) {
      const size = buf.readInt32BE(p)
      p += 4
      if (size <= 0 || p + size > buf.length) break
      out.push(...parseOscPacket(buf.subarray(p, p + size)))
      p += size
    }
    return out
  }
  return [parseMessage(buf)]
}

function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, 'utf8')
  const b = Buffer.alloc(pad4(raw.length + 1))
  raw.copy(b)
  return b
}

/** Числа: целые → i, дробные → f. */
export function encodeOscMessage(address: string, args: OscArg[] = []): Buffer {
  let tags = ','
  const parts: Buffer[] = []
  for (const a of args) {
    if (typeof a === 'number') {
      const b = Buffer.alloc(4)
      if (Number.isInteger(a)) {
        tags += 'i'
        b.writeInt32BE(a)
      } else {
        tags += 'f'
        b.writeFloatBE(a)
      }
      parts.push(b)
    } else if (typeof a === 'string') {
      tags += 's'
      parts.push(encodeString(a))
    } else if (a === true) tags += 'T'
    else if (a === false) tags += 'F'
    else tags += 'N'
  }
  return Buffer.concat([encodeString(address), encodeString(tags), ...parts])
}

export function encodeOscBundle(messages: Buffer[]): Buffer {
  const head = Buffer.alloc(16)
  head.write(BUNDLE_TAG, 0, 'ascii')
  head.writeUInt32BE(0, 8)
  head.writeUInt32BE(1, 12) // тайм-тег «немедленно»
  const parts: Buffer[] = [head]
  for (const m of messages) {
    const size = Buffer.alloc(4)
    size.writeInt32BE(m.length)
    parts.push(size, m)
  }
  return Buffer.concat(parts)
}
