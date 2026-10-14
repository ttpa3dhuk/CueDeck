import { createRequire } from 'node:module'
import type { WebContents, UtilityProcess } from 'electron'
import type { OmtInputFrame } from '../../shared/omt-input.js'
type Video = Extract<OmtInputFrame, { type: 'video' }>
interface Imported { release(): void }
interface GpuApi {
  importSharedTexture(options: { textureInfo: { pixelFormat: string; codedSize: { width: number; height: number }; timestamp: number; handle: { ntHandle: Buffer } }; allReferencesReleased(): void }): Imported
  sendSharedTexture(options: { frame: WebContents['mainFrame']; importedSharedTexture: Imported }, metadata: { address: string; frame: Video }): Promise<void>
}
const require = createRequire(import.meta.url)
export function gpuFrameApi(): GpuApi | undefined {
  return process.platform === 'win32' ? (require('electron') as { sharedTexture?: GpuApi }).sharedTexture : undefined
}

function kernelBindings() {
  const k = require('koffi') as typeof import('koffi'), kernel = k.load('kernel32.dll')
  return { k,
    open: kernel.func('void * __stdcall OpenProcess(uint32 access,bool inherit,uint32 pid)'),
    current: kernel.func('void * __stdcall GetCurrentProcess()'),
    duplicate: kernel.func('bool __stdcall DuplicateHandle(void *source,uint64 handle,void *target,_Out_ void **copy,uint32 access,bool inherit,uint32 options)'),
    close: kernel.func('bool __stdcall CloseHandle(void *handle)'),
  }
}
let bindings: ReturnType<typeof kernelBindings> | undefined

/** Duplicate the helper's process-local NT handle; never transmit CPU pixels through main. */
export async function importGpuFrame(worker: UtilityProcess, wc: WebContents | undefined, address: string, frame: Video, active: () => boolean = () => !!wc && !wc.isDestroyed()): Promise<void> {
  const texture = frame.texture!
  const release = (): void => { try { worker.postMessage({ type: 'gpu-release', id: texture.id }) } catch { /* helper already exited */ } }
  if (!wc || wc.isDestroyed()) { release(); return }
  let close: ((handle: unknown) => void) | undefined, handle: unknown
  let imported: Imported | undefined, releaseOnError = true
  try {
    const api = gpuFrameApi()
    if (!api) throw new Error('Shared GPU textures unavailable')
    const { k, open, current, duplicate, close: closeHandle } = bindings ??= kernelBindings()
    close = closeHandle
    const source = open(0x40, false, texture.owner)
    if (!source) throw new Error('Cannot open OMT texture owner')
    const copy = [null]
    try { if (!duplicate(source, BigInt(texture.handle), current(), copy, 0, false, 2)) throw new Error('Cannot duplicate OMT texture') }
    finally { close(source) }
    handle = copy[0]
    const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(k.address(handle))
    imported = api.importSharedTexture({ textureInfo: { pixelFormat: 'bgra', codedSize: { width: frame.width, height: frame.height }, timestamp: Math.round(frame.timestamp / 10), handle: { ntHandle: bytes } },
      allReferencesReleased: () => { close!(handle); release() } })
    releaseOnError = false
    await api.sendSharedTexture({ frame: wc.mainFrame, importedSharedTexture: imported }, { address, frame })
  } catch (error) {
    if (active()) {
      console.warn('[OMT GPU] falling back to copied frames:', error)
      try { worker.postMessage({ type: 'gpu-disable' }) } catch { /* helper exited */ }
    }
    if (releaseOnError) { if (handle && close) close(handle); release() }
  } finally { imported?.release() }
}
