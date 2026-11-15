import { expect, it, vi } from 'vitest'
const fork = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ utilityProcess: { fork } }))
import { MobileClickerService } from '../src/main/mobile-clicker-service'
import type { CloudpubTunnel } from '../src/main/cloudpub'

it('returns an inactive status while waiting for tunnel shutdown without creating a worker', async () => {
  let finish!: () => void
  const stopped = new Promise<void>(resolve => { finish = resolve })
  const tunnel = { cancel: vi.fn(), stop: vi.fn(() => stopped) }
  const service = new MobileClickerService(() => ({ current: 1, total: 2, remaining: 1,
    canNavigate: true, timer: { text: '00:00', color: 'neutral' } }), vi.fn(),
  { load: async () => null, save: async () => {} }, tunnel as unknown as CloudpubTunnel)
  const disposing = service.dispose()
  expect(await service.status()).toMatchObject({ enabled: false, urls: [], error: null })
  expect(fork).not.toHaveBeenCalled()
  finish(); await disposing
  expect(await service.status()).toMatchObject({ enabled: false, urls: [] })
  expect(fork).not.toHaveBeenCalled()
})
