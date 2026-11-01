import { describe, expect, it } from 'vitest'
import {
  ACK_HEADER_BYTES,
  FRAME_HEADER_BYTES,
  FrameSendGate,
  STATUS_PUBLISHED,
  STATUS_READY,
  SyphonProtocolError,
  decodeAck,
  decodeFrameHeader,
  encodeAck,
  encodeFrameHeader,
} from '../src/main/syphon-bridge-protocol'

const frame = {
  width: 64,
  height: 32,
  stride: 64 * 4,
  payloadLength: 64 * 32 * 4,
  frameId: 7,
  premultiplied: true,
  origin: 'top-left' as const,
}

describe('Syphon bridge frame protocol', () => {
  it('round-trips a bounded top-left premultiplied frame header', () => {
    const header = encodeFrameHeader(frame)
    expect(header.length).toBe(FRAME_HEADER_BYTES)
    expect(header.toString('ascii', 0, 4)).toBe('CDSB')
    expect(decodeFrameHeader(header)).toEqual(frame)
  })

  it('round-trips bottom-left origin without changing dimensions', () => {
    const header = encodeFrameHeader({ ...frame, origin: 'bottom-left' })
    expect(decodeFrameHeader(header).origin).toBe('bottom-left')
  })

  it('rejects bad magic, version, checksum and non-premultiplied frames', () => {
    const header = encodeFrameHeader(frame)
    const badMagic = Buffer.from(header); badMagic[0] = 0x58
    expect(() => decodeFrameHeader(badMagic)).toThrow(SyphonProtocolError)
    const badVersion = Buffer.from(header); badVersion.writeUInt16LE(99, 4)
    expect(() => decodeFrameHeader(badVersion)).toThrow(/version/)
    const badChecksum = Buffer.from(header); badChecksum[36] ^= 0xff
    expect(() => decodeFrameHeader(badChecksum)).toThrow(/checksum/)
    const noPremul = encodeFrameHeader({ ...frame })
    noPremul.writeUInt32LE(noPremul.readUInt32LE(8) & ~1, 8)
    expect(() => decodeFrameHeader(noPremul)).toThrow(/premultiplied|checksum/)
  })

  it('rejects oversized dimensions, invalid stride and payload mismatch', () => {
    expect(() => encodeFrameHeader({ ...frame, width: 4097, stride: 4097 * 4, payloadLength: 4097 * 32 * 4 }))
      .toThrow(/width|payload|64 MiB/)
    expect(() => encodeFrameHeader({ ...frame, stride: 64 * 4 - 4, payloadLength: (64 * 4 - 4) * 32 }))
      .toThrow(/stride/)
    expect(() => encodeFrameHeader({ ...frame, payloadLength: frame.payloadLength - 4 }))
      .toThrow(/payload length/)
  })

  it('round-trips ready and published acknowledgements', () => {
    expect(decodeAck(encodeAck(STATUS_READY, 0))).toEqual({ status: STATUS_READY, frameId: 0, detail: 0 })
    expect(decodeAck(encodeAck(STATUS_PUBLISHED, 42, 9))).toEqual({ status: STATUS_PUBLISHED, frameId: 42, detail: 9 })
    expect(encodeAck(STATUS_READY, 0).length).toBe(ACK_HEADER_BYTES)
  })

  it('allows exactly one frame in flight and clears on ack or timeout', () => {
    const gate = new FrameSendGate()
    expect(gate.begin()).toBe(false)
    gate.markReady()
    expect(gate.begin()).toBe(true)
    expect(gate.begin()).toBe(false)
    gate.ack()
    expect(gate.canSend()).toBe(true)
    expect(gate.begin()).toBe(true)
    gate.timeout()
    expect(gate.begin()).toBe(true)
    gate.markDead()
    expect(gate.begin()).toBe(false)
  })
})
