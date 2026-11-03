import { describe, expect, it } from 'vitest'
import { localGpuNativePath, macSyphonSupported } from '../src/main/local-gpu-path'

describe('local GPU native library trust boundary', () => {
  it('ignores development library overrides in packaged Windows', () => {
    expect(localGpuNativePath('win32', true, '/app', '/resources', {
      CUEDECK_SPOUT_GPU_NATIVE: '/untrusted.dll',
    })).toBe('/resources/spout/cuedeck_spout_gpu.dll')
    expect(localGpuNativePath('darwin', true, '/app', '/resources', {
      CUEDECK_SYPHON_GPU_NATIVE: '/untrusted.dylib',
    })).toBe('/resources/syphon/libcuedeck_syphon_gpu.dylib')
  })

  it('keeps native Syphon unavailable on older Macs without preventing the base app from running', () => {
    expect(macSyphonSupported('21.6.0')).toBe(false)
    expect(macSyphonSupported('22.0.0')).toBe(true)
    expect(macSyphonSupported('27.0.0')).toBe(true)
  })

  it('keeps the Mac path and resolves only the matching development override', () => {
    expect(localGpuNativePath('darwin', false, '/app', '/resources', {}))
      .toBe('/app/native/syphon-probe/build/libcuedeck_syphon_gpu.dylib')
    expect(localGpuNativePath('win32', false, '/app', '/resources', {
      CUEDECK_SYPHON_GPU_NATIVE: '/mac.dylib', CUEDECK_SPOUT_GPU_NATIVE: 'test/spout.dll',
    })).toBe('/app/test/spout.dll')
  })
})
