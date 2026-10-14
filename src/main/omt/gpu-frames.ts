import { createRequire } from 'node:module'
import type { NativeFrame } from './inputs.js'
import type { OmtInputFrame } from '../../shared/omt-input.js'

type Video = Extract<OmtInputFrame, { type: 'video' }>
interface Texture { handle: string; dispose(): void }
interface Entry { texture: Texture; address: string; users: number }

/** Immutable D3D11 textures: native pixels are uploaded once, before libomt reuses them. */
export class OmtGpuFrames {
  private entries = new Map<number, Entry>()
  private nextId = 0
  private enabled = true
  private makeTexture: (width: number, height: number, pixels: unknown, stride: number) => Texture
  private closeDevice: () => void
  constructor(backend?: { makeTexture(width: number, height: number, pixels: unknown, stride: number): Texture; close(): void }) {
    if (backend) { this.makeTexture = (...args) => backend.makeTexture(...args); this.closeDevice = () => backend.close(); return }
    const k = createRequire(import.meta.url)('koffi') as typeof import('koffi')
    const d3d = k.load('d3d11.dll'), kernel = k.load('kernel32.dll')
    const create = d3d.func('long __stdcall D3D11CreateDevice(void *adapter,uint32 driver,void *software,uint32 flags,void *levels,uint32 count,uint32 sdk,_Out_ void **device,_Out_ uint32 *level,_Out_ void **context)')
    const close = kernel.func('bool __stdcall CloseHandle(void *handle)')
    const sample = k.struct('OmtGpuSample', { Count: 'uint32', Quality: 'uint32' })
    const desc = k.struct('OmtGpuDesc', { Width: 'uint32', Height: 'uint32', MipLevels: 'uint32', ArraySize: 'uint32', Format: 'uint32', SampleDesc: sample, Usage: 'uint32', BindFlags: 'uint32', CPUAccessFlags: 'uint32', MiscFlags: 'uint32' })
    k.struct('OmtGpuData', { pSysMem: 'void *', SysMemPitch: 'uint32', SysMemSlicePitch: 'uint32' })
    const qi = k.proto('long __stdcall OmtGpuQI(void *self,void *iid,_Out_ void **object)')
    const release = k.proto('uint32 __stdcall OmtGpuRelease(void *self)')
    const texture2d = k.proto('long __stdcall OmtGpuTexture(void *self,OmtGpuDesc *desc,OmtGpuData *initial,_Out_ void **texture)')
    const shared = k.proto('long __stdcall OmtGpuShared(void *self,void *attributes,uint32 access,str16 name,_Out_ void **handle)')
    const flush = k.proto('void __stdcall OmtGpuFlush(void *self)')
    const call = (pointer: unknown, index: number, type: Parameters<typeof k.call>[1], ...args: unknown[]): unknown => {
      const table = k.decode(pointer, 'void *')
      const entries = k.decode(table, k.array('void *', index + 1)) as unknown[]
      return k.call(entries[index], type, pointer, ...args)
    }
    const check = (hr: unknown, label: string): void => { if (Number(hr) < 0) throw new Error(`${label}: HRESULT ${(Number(hr) >>> 0).toString(16)}`) }
    const device = [null], level = [0], context = [null]
    check(create(null, 1, null, 0x20, null, 0, 7, device, level, context), 'D3D11CreateDevice')
    const iid = Buffer.from('791396300946414a998e54fe567ee0c1', 'hex') // IID_IDXGIResource1
    this.makeTexture = (width, height, pixels, stride) => {
      const texture = [null], resource = [null], handle = [null]
      try {
        check(call(device[0], 5, texture2d, {
          Width: width, Height: height, MipLevels: 1, ArraySize: 1, Format: 87,
          SampleDesc: { Count: 1, Quality: 0 }, Usage: 0, BindFlags: 0x28, CPUAccessFlags: 0,
          MiscFlags: 0x802, // SHARED + SHARED_NTHANDLE; immutable BGRA textures need no keyed mutex.
        }, { pSysMem: pixels, SysMemPitch: stride, SysMemSlicePitch: stride * height }, texture), 'CreateTexture2D')
        check(call(texture[0], 0, qi, iid, resource), 'QueryInterface IDXGIResource1')
        check(call(resource[0], 13, shared, null, 0x80000001, null, handle), 'CreateSharedHandle')
        call(context[0], 111, flush)
        let disposed = false
        return { handle: k.address(handle[0]).toString(), dispose: () => {
          if (disposed) return
          disposed = true; close(handle[0]); call(texture[0], 2, release)
        } }
      } catch (error) {
        if (handle[0]) close(handle[0])
        if (texture[0]) call(texture[0], 2, release)
        throw error
      } finally { if (resource[0]) call(resource[0], 2, release) }
    }
    this.closeDevice = () => { call(context[0], 2, release); call(device[0], 2, release) }
  }

  create(frame: NativeFrame, address: string): Video | null | undefined {
    // Preserve the existing alpha conversion path. Unsupported GPUs use copied frames.
    if (!this.enabled || frame.Flags & 2) return undefined
    if (this.entries.size >= 32 || [...this.entries.values()].filter(e => e.address === address).length >= 5) return null
    const texture = this.makeTexture(frame.Width, frame.Height, frame.Data, frame.Stride)
    const id = ++this.nextId
    this.entries.set(id, { texture, address, users: 0 })
    return { type: 'video', data: new Uint8Array(0), width: frame.Width, height: frame.Height, stride: frame.Stride,
      flags: frame.Flags, timestamp: Number(frame.Timestamp), frameRateN: frame.FrameRateN, frameRateD: frame.FrameRateD,
      texture: { id, handle: texture.handle, owner: process.pid } }
  }
  retain(id: number): void { const entry = this.entries.get(id); if (entry) entry.users++ }
  release(id: number): void {
    const entry = this.entries.get(id)
    if (entry && --entry.users <= 0) { this.entries.delete(id); entry.texture.dispose() }
  }
  discardUnused(frame: OmtInputFrame): void {
    if (frame.type !== 'video' || !frame.texture) return
    const entry = this.entries.get(frame.texture.id)
    if (entry && !entry.users) this.release(frame.texture.id)
  }
  disable(): void { this.enabled = false }
  close(): void { for (const entry of this.entries.values()) entry.texture.dispose(); this.entries.clear(); this.closeDevice() }
}
