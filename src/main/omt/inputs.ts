import {
  OMT_CODEC_BGRA, OMT_CODEC_FPA1,
  OMT_FRAME_VIDEO, OMT_FRAME_AUDIO, type OmtLib,
} from './libomt-native.js'
import type { OmtInputFrame, OmtInputSource } from '../../shared/omt-input.js'
import { validOmtAddress } from '../../shared/omt-input.js'

type FrameHandler = (address: string, frame: OmtInputFrame) => void
type Tally = { preview: number; program: number }
interface Consumer { addresses: Set<string>; onFrame: FrameHandler; tally: Map<string, Tally> }
interface Receiver {
  address: string
  instance: unknown
  timer: ReturnType<typeof setTimeout> | null
  pending: boolean
  closing: boolean
  lastErrorAt: number
}
export interface NativeFrame {
  Type: number; Timestamp: number | bigint; Codec: number
  Width: number; Height: number; Stride: number; Flags: number
  FrameRateN: number; FrameRateD: number
  SampleRate: number; Channels: number; SamplesPerChannel: number
  Data: unknown; DataLength: number
}
const MEDIA_TYPES = OMT_FRAME_VIDEO | OMT_FRAME_AUDIO
const MAX_VIDEO_BYTES = 8192 * 8192 * 4
const MAX_AUDIO_BYTES = 32 * 192000 * 4

function validAddress(value: string): boolean {
  return validOmtAddress(value) && Buffer.byteLength(value, 'utf8') < 1024
}

/** One network connection per source; all renderers share its copied frames.
 * Native receive/decode runs in Koffi's thread pool. No native buffer survives
 * the callback: libomt owns it and may reuse it on the next receive.
 */
export class OmtInputManager {
  private consumers = new Map<number, Consumer>()
  private receivers = new Map<string, Receiver>()
  private library: OmtLib | null = null
  private closed = false

  constructor(private readonly libraryProvider: () => OmtLib, private readonly errorLogger: (message: string) => void = console.warn, private readonly gpuVideo?: (frame: NativeFrame, address: string) => OmtInputFrame | null | undefined, private readonly frameHandled?: (frame: OmtInputFrame) => void) {}

  private getLib(): OmtLib {
    const library = this.library ?? this.libraryProvider()
    this.library = library
    return library
  }

  discover(): OmtInputSource[] {
    if (this.closed) return []
    const library = this.getLib()
    const count = [0]
    const pointer = library.discoveryGetAddresses(count)
    if (!pointer || !Number.isInteger(count[0]) || count[0] <= 0 || count[0] > 4096) return []
    // Discovery memory remains valid only until the next discovery call.
    const addresses = library.koffi.decode(pointer, library.koffi.array('char *', count[0])) as string[]
    return [...new Set(addresses.filter(validAddress))].map(address => ({ name: address, address }))
  }

  retain(consumerId: number, addresses: string[], onFrame: FrameHandler): void {
    if (this.closed) return
    const desired = new Set(addresses.filter(validAddress))
    if (desired.size > 32) throw new Error('Too many OMT sources')
    if (desired.size) this.getLib()
    const previous = this.consumers.get(consumerId)
    const started: string[] = []
    try {
      for (const address of desired) {
        if (!this.receivers.has(address)) {
          this.start(address)
          started.push(address)
        }
      }
    } catch (error) {
      for (const address of started) {
        this.stop(this.receivers.get(address)!)
        this.receivers.delete(address)
      }
      throw error
    }
    this.consumers.set(consumerId, { addresses: desired, onFrame, tally: previous?.tally ?? new Map() })
    this.reconcile()
  }

  release(consumerId: number): void {
    this.consumers.delete(consumerId)
    this.reconcile()
  }

  setTally(consumerId: number, address: string, tally: Tally): void {
    const consumer = this.consumers.get(consumerId)
    if (!consumer?.addresses.has(address)) return
    consumer.tally.set(address, { preview: tally.preview ? 1 : 0, program: tally.program ? 1 : 0 })
    this.updateTally(address)
  }

  destroy(): void {
    this.closed = true
    this.consumers.clear()
    for (const receiver of this.receivers.values()) this.stop(receiver)
    this.receivers.clear()
  }

  private reconcile(): void {
    const wanted = new Set([...this.consumers.values()].flatMap(consumer => [...consumer.addresses]))
    for (const [address, receiver] of this.receivers) {
      if (!wanted.has(address)) {
        this.stop(receiver)
        this.receivers.delete(address)
      } else this.updateTally(address)
    }
  }

  private updateTally(address: string): void {
    const receiver = this.receivers.get(address)
    if (!receiver || receiver.closing) return
    const tally: Tally = { preview: 0, program: 0 }
    for (const consumer of this.consumers.values()) {
      if (!consumer.addresses.has(address)) continue
      const own = consumer.tally.get(address)
      tally.preview |= own?.preview ?? 0
      tally.program |= own?.program ?? 0
    }
    this.library!.receiveSetTally(receiver.instance, tally)
  }

  private start(address: string): void {
    const instance = this.getLib().receiveCreate(address, MEDIA_TYPES, 2 /* BGRA */, 0)
    if (!instance) throw new Error(`OMT receiver could not be created: ${address}`)
    const receiver: Receiver = { address, instance, timer: null, pending: false, closing: false, lastErrorAt: 0 }
    this.receivers.set(address, receiver)
    this.schedule(receiver, 0)
  }

  private schedule(receiver: Receiver, delay: number): void {
    if (receiver.closing) return
    receiver.timer = setTimeout(() => {
      receiver.timer = null
      this.poll(receiver)
    }, delay)
  }

  private poll(receiver: Receiver): void {
    if (receiver.closing || receiver.pending) return
    receiver.pending = true
    try {
      // Even timeout=0 may decode a large compressed frame, so invoke asynchronously.
      this.library!.receive.async(receiver.instance, MEDIA_TYPES, 0, (error: unknown, pointer: unknown) => {
        receiver.pending = false
        if (receiver.closing) {
          this.dispose(receiver)
          return
        }
        try {
          if (error) throw error
          if (pointer) {
            const native = this.library!.koffi.decode(pointer, 'OMTMediaFrame') as NativeFrame
            const frame = this.copyFrame(native, receiver.address)
            if (frame) {
              for (const consumer of this.consumers.values()) {
                if (!consumer.addresses.has(receiver.address)) continue
                try { consumer.onFrame(receiver.address, frame) }
                catch (err) { this.reportError(receiver, err) }
              }
              this.frameHandled?.(frame)
            }
          }
          this.schedule(receiver, pointer ? 0 : 8)
        } catch (err) {
          this.reportError(receiver, err)
          this.schedule(receiver, 100)
        }
      })
    } catch (err) {
      receiver.pending = false
      this.reportError(receiver, err)
      this.schedule(receiver, 100)
    }
  }

  private copyFrame(native: NativeFrame, address: string): OmtInputFrame | null {
    const timestamp = Number(native.Timestamp)
    if (!Number.isFinite(timestamp) || !native.Data || !Number.isInteger(native.DataLength)) return null
    if (native.Type === OMT_FRAME_VIDEO) {
      const { Width: width, Height: height, Stride: stride } = native
      if (native.Codec !== OMT_CODEC_BGRA || !Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(stride)
        || width < 1 || width > 8192 || height < 1 || height > 8192 || stride < width * 4
        || stride * height > MAX_VIDEO_BYTES || native.DataLength < stride * height || native.DataLength > MAX_VIDEO_BYTES) return null
      const gpu = this.gpuVideo?.(native, address)
      if (gpu !== undefined) return gpu
      const data = this.copyBytes(native.Data, stride * height)
      return { type: 'video', data, width, height, stride, flags: native.Flags, timestamp,
        frameRateN: native.FrameRateN, frameRateD: native.FrameRateD }
    }
    if (native.Type === OMT_FRAME_AUDIO) {
      const { SampleRate: sampleRate, Channels: channels, SamplesPerChannel: samplesPerChannel } = native
      const bytes = channels * samplesPerChannel * 4
      if (native.Codec !== OMT_CODEC_FPA1 || !Number.isInteger(channels) || channels < 1 || channels > 32
        || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
        || !Number.isInteger(samplesPerChannel) || samplesPerChannel < 1 || samplesPerChannel > sampleRate
        || bytes > MAX_AUDIO_BYTES || native.DataLength < bytes || native.DataLength > MAX_AUDIO_BYTES) return null
      // Copy before decoding or receiving again. Keep FPA1 channel planes.
      const planar = this.copyBytes(native.Data, bytes)
      const data = new Float32Array(channels * samplesPerChannel)
      for (let channel = 0; channel < channels; channel++) {
        for (let sample = 0; sample < samplesPerChannel; sample++) {
          const value = planar.readFloatLE((channel * samplesPerChannel + sample) * 4)
          data[channel * samplesPerChannel + sample] = Number.isFinite(value) ? value : 0
        }
      }
      return { type: 'audio', data, sampleRate, channels, samplesPerChannel, timestamp }
    }
    return null
  }

  private copyBytes(pointer: unknown, length: number): Buffer {
    const koffi = this.library!.koffi
    // Electron's V8 forbids external ArrayBuffers: koffi.view can terminate
    // the process. decode a Typed array instead; it owns a copy of the bytes.
    const bytes = koffi.decode(pointer, koffi.array('uint8_t', length, 'Typed')) as Uint8Array
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  private stop(receiver: Receiver): void {
    receiver.closing = true
    if (receiver.timer) clearTimeout(receiver.timer)
    receiver.timer = null
    // Never free a handle while a thread-pool receive is still using it.
    if (!receiver.pending) this.dispose(receiver)
  }

  private dispose(receiver: Receiver): void {
    if (!receiver.instance) return
    try { this.library!.receiveDestroy(receiver.instance) }
    catch (error) { this.reportError(receiver, error) }
    receiver.instance = null
  }

  private reportError(receiver: Receiver, error: unknown): void {
    if (Date.now() - receiver.lastErrorAt < 5000) return
    receiver.lastErrorAt = Date.now()
    this.errorLogger(`omt input ${receiver.address}: ${String(error)}`)
  }
}
