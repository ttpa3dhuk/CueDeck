import { describe, expect, it } from 'vitest'
import { sharedGpuHandle } from '../src/main/syphon-gpu-core'

describe('Electron GPU handle versions', () => {
  const handle = Buffer.alloc(8, 1)
  it('accepts Electron 33 handles and Electron 44 platform handle objects', () => {
    expect(sharedGpuHandle({ sharedTextureHandle: handle }, 'darwin')).toBe(handle)
    expect(sharedGpuHandle({ sharedTextureHandle: handle }, 'win32')).toBe(handle)
    expect(sharedGpuHandle({ handle: { ntHandle: handle } }, 'win32')).toBe(handle)
    expect(sharedGpuHandle({ handle: { ioSurface: handle } }, 'darwin')).toBe(handle)
  })
  it('rejects null, truncated and foreign platform handles', () => {
    expect(sharedGpuHandle({ handle: { ioSurface: handle } }, 'win32')).toBeNull()
    expect(sharedGpuHandle({ handle: { ntHandle: Buffer.alloc(4) } }, 'win32')).toBeNull()
    expect(sharedGpuHandle({ handle: { ntHandle: Buffer.alloc(8) } }, 'win32')).toBeNull()
  })
})
