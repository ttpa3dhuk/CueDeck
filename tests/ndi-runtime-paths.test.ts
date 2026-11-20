import { describe, expect, it } from 'vitest'
import { ndiRuntimeDirectories } from '../src/main/ndi/runtime-paths'

describe('installed NDI runtime discovery', () => {
  it('uses bundled libraries first and standard macOS install second', () => {
    expect(ndiRuntimeDirectories('/app/ndi', 'darwin', {})).toEqual(['/app/ndi', '/usr/local/lib'])
  })
  it('finds runtime environment paths without requiring vendor files', () => {
    expect(ndiRuntimeDirectories('/bundle', 'win32', {
      NDI_RUNTIME_DIR_V6: '/runtime6', NDI_RUNTIME_DIR_V5: '/runtime5', NDI_RUNTIME_DIR_V4: '/runtime5',
    })).toEqual(['/bundle', '/runtime6', '/runtime5'])
  })
})
