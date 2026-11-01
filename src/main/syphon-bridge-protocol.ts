/**
 * Bounded binary protocol between the CueDeck main process and the native
 * Syphon helper. This module is pure Node code (no Electron) so framing and
 * validation are unit-testable.
 *
 * Frame header (40 bytes, little-endian):
 *   0  char[4] magic "CDSB"
 *   4  u16 version (1)
 *   6  u16 header length (40)
 *   8  u32 flags: bit0 premultiplied BGRA, bit1 origin top-left
 *   12 u32 width
 *   16 u32 height
 *   20 u32 stride (bytes)
 *   24 u32 payload length
 *   28 u64 frame id
 *   36 u32 FNV-1a checksum of bytes 0..35
 * followed by exactly payload length bytes of BGRA pixels.
 *
 * Ack header (24 bytes, little-endian):
 *   0  char[4] magic "CDSA"
 *   4  u16 version (1)
 *   6  u16 header length (24)
 *   8  u32 status
 *   12 u64 frame id
 *   20 u32 detail
 */
import { Buffer } from 'node:buffer'

export const FRAME_MAGIC = 'CDSB'
export const ACK_MAGIC = 'CDSA'
export const PROTOCOL_VERSION = 1
export const FRAME_HEADER_BYTES = 40
export const ACK_HEADER_BYTES = 24

export const FRAME_FLAG_PREMULTIPLIED = 1
export const FRAME_FLAG_TOP_LEFT = 2
export const FRAME_FLAGS_KNOWN = FRAME_FLAG_PREMULTIPLIED | FRAME_FLAG_TOP_LEFT

export const MIN_FRAME_DIMENSION = 16
export const MAX_FRAME_WIDTH = 4096
export const MAX_FRAME_HEIGHT = 2160
export const MAX_FRAME_STRIDE = 16384
export const MAX_FRAME_PAYLOAD = 64 * 1024 * 1024

export const STATUS_PUBLISHED = 0
export const STATUS_READY = 1
export const STATUS_BAD_FRAME = 2
export const STATUS_GPU_TIMEOUT = 3
export const STATUS_INTERNAL = 4
export const STATUS_PROTOCOL_ERROR = 5

export type AckStatus =
  | typeof STATUS_PUBLISHED
  | typeof STATUS_READY
  | typeof STATUS_BAD_FRAME
  | typeof STATUS_GPU_TIMEOUT
  | typeof STATUS_INTERNAL
  | typeof STATUS_PROTOCOL_ERROR

export interface FrameHeader {
  width: number
  height: number
  stride: number
  payloadLength: number
  frameId: number
  premultiplied: boolean
  origin: 'top-left' | 'bottom-left'
}

export interface AckHeader {
  status: AckStatus
  frameId: number
  detail: number
}

export class SyphonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyphonProtocolError'
  }
}

function fnv1a(bytes: Buffer, start = 0, end = bytes.length): number {
  let hash = 0x811c9dc5
  for (let i = start; i < end; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function requireInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SyphonProtocolError(`${name} out of range: ${value}`)
  }
}

export function validateFrameShape(header: Pick<FrameHeader, 'width' | 'height' | 'stride' | 'payloadLength'>): void {
  requireInteger('width', header.width, MIN_FRAME_DIMENSION, MAX_FRAME_WIDTH)
  requireInteger('height', header.height, MIN_FRAME_DIMENSION, MAX_FRAME_HEIGHT)
  requireInteger('stride', header.stride, header.width * 4, MAX_FRAME_STRIDE)
  if (header.stride % 4 !== 0) throw new SyphonProtocolError('stride must be a multiple of 4')
  requireInteger('payloadLength', header.payloadLength, 0, MAX_FRAME_PAYLOAD)
  if (header.payloadLength !== header.stride * header.height) {
    throw new SyphonProtocolError(
      `payload length ${header.payloadLength} != stride ${header.stride} * height ${header.height}`,
    )
  }
  if (header.width * header.height * 4 > MAX_FRAME_PAYLOAD) {
    throw new SyphonProtocolError('frame exceeds the 64 MiB payload limit')
  }
}

export function encodeFrameHeader(header: FrameHeader): Buffer {
  requireInteger('frameId', header.frameId, 1, Number.MAX_SAFE_INTEGER)
  validateFrameShape(header)
  const flags =
    (header.premultiplied ? FRAME_FLAG_PREMULTIPLIED : 0) |
    (header.origin === 'top-left' ? FRAME_FLAG_TOP_LEFT : 0)
  const buffer = Buffer.alloc(FRAME_HEADER_BYTES)
  buffer.write(FRAME_MAGIC, 0, 4, 'ascii')
  buffer.writeUInt16LE(PROTOCOL_VERSION, 4)
  buffer.writeUInt16LE(FRAME_HEADER_BYTES, 6)
  buffer.writeUInt32LE(flags >>> 0, 8)
  buffer.writeUInt32LE(header.width, 12)
  buffer.writeUInt32LE(header.height, 16)
  buffer.writeUInt32LE(header.stride, 20)
  buffer.writeUInt32LE(header.payloadLength, 24)
  buffer.writeBigUInt64LE(BigInt(header.frameId), 28)
  buffer.writeUInt32LE(fnv1a(buffer, 0, 36), 36)
  return buffer
}

export function decodeFrameHeader(buffer: Buffer): FrameHeader {
  if (buffer.length !== FRAME_HEADER_BYTES) {
    throw new SyphonProtocolError(`frame header must be ${FRAME_HEADER_BYTES} bytes, got ${buffer.length}`)
  }
  if (buffer.toString('ascii', 0, 4) !== FRAME_MAGIC) throw new SyphonProtocolError('bad frame magic')
  if (buffer.readUInt16LE(4) !== PROTOCOL_VERSION) throw new SyphonProtocolError('unsupported protocol version')
  if (buffer.readUInt16LE(6) !== FRAME_HEADER_BYTES) throw new SyphonProtocolError('bad frame header length')
  const checksum = buffer.readUInt32LE(36)
  if (checksum !== fnv1a(buffer, 0, 36)) throw new SyphonProtocolError('bad frame header checksum')
  const flags = buffer.readUInt32LE(8)
  if ((flags & ~FRAME_FLAGS_KNOWN) !== 0) throw new SyphonProtocolError('unknown frame flags')
  if ((flags & FRAME_FLAG_PREMULTIPLIED) === 0) throw new SyphonProtocolError('BGRA must be premultiplied')
  const width = buffer.readUInt32LE(12)
  const height = buffer.readUInt32LE(16)
  const stride = buffer.readUInt32LE(20)
  const payloadLength = buffer.readUInt32LE(24)
  validateFrameShape({ width, height, stride, payloadLength })
  const frameId = Number(buffer.readBigUInt64LE(28))
  requireInteger('frameId', frameId, 1, Number.MAX_SAFE_INTEGER)
  return {
    width,
    height,
    stride,
    payloadLength,
    frameId,
    premultiplied: true,
    origin: (flags & FRAME_FLAG_TOP_LEFT) !== 0 ? 'top-left' : 'bottom-left',
  }
}

export function encodeAck(status: AckStatus, frameId: number, detail = 0): Buffer {
  requireInteger('ack frameId', frameId, 0, Number.MAX_SAFE_INTEGER)
  requireInteger('ack detail', detail, 0, 0xffffffff)
  const buffer = Buffer.alloc(ACK_HEADER_BYTES)
  buffer.write(ACK_MAGIC, 0, 4, 'ascii')
  buffer.writeUInt16LE(PROTOCOL_VERSION, 4)
  buffer.writeUInt16LE(ACK_HEADER_BYTES, 6)
  buffer.writeUInt32LE(status >>> 0, 8)
  buffer.writeBigUInt64LE(BigInt(frameId), 12)
  buffer.writeUInt32LE(detail >>> 0, 20)
  return buffer
}

export function decodeAck(buffer: Buffer): AckHeader {
  if (buffer.length !== ACK_HEADER_BYTES) {
    throw new SyphonProtocolError(`ack header must be ${ACK_HEADER_BYTES} bytes, got ${buffer.length}`)
  }
  if (buffer.toString('ascii', 0, 4) !== ACK_MAGIC) throw new SyphonProtocolError('bad ack magic')
  if (buffer.readUInt16LE(4) !== PROTOCOL_VERSION) throw new SyphonProtocolError('unsupported ack version')
  if (buffer.readUInt16LE(6) !== ACK_HEADER_BYTES) throw new SyphonProtocolError('bad ack header length')
  const status = buffer.readUInt32LE(8) as AckStatus
  if (![STATUS_PUBLISHED, STATUS_READY, STATUS_BAD_FRAME, STATUS_GPU_TIMEOUT, STATUS_INTERNAL, STATUS_PROTOCOL_ERROR].includes(status)) {
    throw new SyphonProtocolError(`unknown ack status: ${status}`)
  }
  const frameId = Number(buffer.readBigUInt64LE(12))
  const detail = buffer.readUInt32LE(20)
  requireInteger('ack frameId', frameId, 0, Number.MAX_SAFE_INTEGER)
  return { status, frameId, detail }
}

/**
 * One-frame-in-flight gate. A new frame is sent only when the helper is ready
 * and the previous frame has been acknowledged. There is deliberately no
 * pending queue: callers drop before doing a CPU readback while `!canSend()`.
 */
export class FrameSendGate {
  private ready = false
  private inFlight = false

  markReady(): void {
    this.ready = true
  }

  markDead(): void {
    this.ready = false
    this.inFlight = false
  }

  canSend(): boolean {
    return this.ready && !this.inFlight
  }

  begin(): boolean {
    if (!this.canSend()) return false
    this.inFlight = true
    return true
  }

  ack(): void {
    this.inFlight = false
  }

  timeout(): void {
    this.inFlight = false
  }

  isInFlight(): boolean {
    return this.inFlight
  }

  isReady(): boolean {
    return this.ready
  }
}
