/**
 * Koffi binding for the in-process macOS Syphon GPU publisher.
 *
 * The raw IOSurface* in textureInfo.sharedTextureHandle is passed only within
 * the Electron main process. There is no IOSurface ID, no global surface and
 * no cross-process handle. CuedeckGpuNative.submit returns before the Metal
 * command buffer completes; the caller must keep the OffscreenSharedTexture
 * alive until poll() reports that frame.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { Buffer } from 'node:buffer'

type Koffi = typeof import('koffi')
type Fn = ReturnType<import('koffi').IKoffiLib['func']>

export interface GpuCompletion {
  frameId: number
  status: number
  detail: number
}

const ERROR_BYTES = 512
const RESULT_BYTES = 16

export class NativeGpuPublisher {
  private readonly destroyFn: Fn
  private readonly submitFn: Fn
  private readonly pollFn: Fn
  private readonly pendingFn: Fn
  private readonly strideFn: Fn
  private readonly handle: unknown
  private destroyed = false

  private constructor(handle: unknown, lib: ReturnType<Koffi['load']>) {
    this.handle = handle
    this.destroyFn = lib.func('void cuedeck_gpu_publisher_destroy(void *publisher)')
    this.submitFn = lib.func(
      'int cuedeck_gpu_publisher_submit(void *publisher, const uint8_t *handle, uint64_t length, ' +
      'uint32_t width, uint32_t height, uint32_t stride, uint32_t pixel_format, uint64_t frame_id, ' +
      'char *error, uint64_t error_length)',
    )
    this.pollFn = lib.func('int cuedeck_gpu_publisher_poll(void *publisher, uint8_t *out, uint64_t length)')
    this.pendingFn = lib.func('int cuedeck_gpu_publisher_pending(void *publisher)')
    this.strideFn = lib.func('uint32_t cuedeck_gpu_surface_stride(const uint8_t *handle, uint64_t length)')
  }

  static load(path: string, name: string, isPrivate: boolean, flipY: boolean): NativeGpuPublisher {
    if (!existsSync(path)) throw new Error(`GPU native publisher not found: ${path}`)
    const koffi = createRequire(import.meta.url)('koffi') as Koffi
    const lib = koffi.load(path)
    const create = lib.func(
      'void *cuedeck_gpu_publisher_create(const char *name, int is_private, int flip_y, char *error, uint64_t error_length)',
    )
    const error = Buffer.alloc(ERROR_BYTES)
    const handle = create(name, isPrivate ? 1 : 0, flipY ? 1 : 0, error, error.length)
    if (!handle) throw new Error(`cannot create GPU publisher: ${errorString(error)}`)
    return new NativeGpuPublisher(handle, lib)
  }

  surfaceStride(handle: Buffer): number | null {
    if (this.destroyed || !Buffer.isBuffer(handle) || handle.length !== 8) return null
    try {
      const value = Number(this.strideFn(handle, handle.length))
      return value > 0 ? value : null
    } catch { return null }
  }

  submit(handle: Buffer, width: number, height: number, stride: number,
         pixelFormat: number, frameId: number): { ok: boolean; error?: string } {
    if (this.destroyed) return { ok: false, error: 'GPU publisher is destroyed' }
    const error = Buffer.alloc(ERROR_BYTES)
    try {
      const result = Number(this.submitFn(this.handle, handle, handle.length, width, height, stride,
        pixelFormat, frameId, error, error.length))
      return result === 0 ? { ok: true } : { ok: false, error: errorString(error) || `submit error ${result}` }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  poll(): GpuCompletion | null {
    if (this.destroyed) return null
    const out = Buffer.alloc(RESULT_BYTES)
    try {
      const got = Number(this.pollFn(this.handle, out, out.length))
      if (got !== 1) return null
      return {
        frameId: Number(out.readBigUInt64LE(0)),
        status: out.readUInt32LE(8),
        detail: out.readUInt32LE(12),
      }
    } catch {
      return null
    }
  }

  pending(): number {
    if (this.destroyed) return 0
    try { return Number(this.pendingFn(this.handle)) } catch { return 0 }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    try { this.destroyFn(this.handle) } catch { /* already gone */ }
  }
}

function errorString(buf: Buffer): string {
  const end = buf.indexOf(0)
  return buf.toString('utf8', 0, end < 0 ? buf.length : end).trim()
}
