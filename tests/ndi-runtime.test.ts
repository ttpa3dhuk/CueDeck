import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ installed: false, initialize: vi.fn(() => true), version: () => 'test' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/no-bundle' } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('node:fs', () => ({ existsSync: () => h.installed }))
vi.mock('../src/main/ndi/libndi-native.js', () => ({
  ndiFileName: () => 'libndi.dylib', createNdiLibrary: () => ({ initialize: h.initialize, version: h.version }),
}))
beforeEach(() => { vi.resetModules(); h.installed = false; h.initialize.mockReset().mockReturnValue(true) })
it('retries a missing runtime on the next enable instead of caching the error until restart', async () => {
  const { loadNdi, ndiLoadError } = await import('../src/main/ndi/libndi')
  expect(loadNdi()).toBeNull()
  expect(ndiLoadError()).toBeTruthy()
  h.installed = true
  expect(loadNdi()).not.toBeNull()
  expect(ndiLoadError()).toBeNull()
  loadNdi()
  expect(h.initialize).toHaveBeenCalledOnce()
})
