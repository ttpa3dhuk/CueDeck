import { expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({ playlist: [] as Record<string, unknown>[] }))
vi.mock('electron-store', () => ({ default: class { get(key: string) { return data[key as keyof typeof data] } } }))
vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
import { getPlaylist } from '../src/main/display-mapping'
it('restores slide fades from application preferences across cold starts, retaining legacy cuts', () => {
  const base = { id: 'deck', kind: 'pdf', filePath: '/deck.pdf', fileName: 'deck.pdf' }
  data.playlist = [{ ...base, slideFadeMs: 350 }, { ...base, id: 'legacy' }, { ...base, id: 'bounded', slideFadeMs: 5000 }]
  const restored = getPlaylist()
  expect(restored[0].slideFadeMs).toBe(350)
  expect(restored[1].slideFadeMs).toBeUndefined()
  expect(restored[2].slideFadeMs).toBe(500)
})
