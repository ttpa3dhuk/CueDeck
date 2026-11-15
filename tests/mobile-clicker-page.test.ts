import { afterEach, describe, expect, it, vi } from 'vitest'
import { Script, createContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { mobileClickerPage } from '../src/main/mobile-clicker-page'
import { DEFAULT_LANG, setLang } from '../src/shared/i18n'

afterEach(() => setLang(DEFAULT_LANG))
const script = () => mobileClickerPage().match(/<script>([\s\S]*?)<\/script>/)![1]
describe('phone page protocol', () => {
  it.each(['ru', 'en'] as const)('emits valid browser JavaScript in %s', lang => {
    setLang(lang)
    expect(() => new Script(script())).not.toThrow()
  })
  it('offers admission on a plain public URL and does not poll without a credential', async () => {
    type Element = { hidden: boolean; disabled: boolean; value: string; textContent: string; dataset: Record<string, string>; addEventListener: ReturnType<typeof vi.fn> }
    const elements = new Map<string, Element>()
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, { hidden: true, disabled: true, value: '', textContent: '', dataset: {}, addEventListener: vi.fn() })
      return elements.get(id)!
    }
    const storage = new Map<string, string>()
    const events = new Map<string, () => void>()
    const key = 'k'.repeat(43)
    const fetch = vi.fn(async (path: string, _options?: { headers?: { Authorization?: string } }) => ({ ok: true, json: async () => path === '/join' ? { key } : { enabled: false, canNavigate: false, current: 0, total: 0, remaining: 0, timer: { text: '--:--', color: 'neutral' }, access: 'approval' } }))
    const context = createContext({
      URLSearchParams, AbortController, crypto: webcrypto, location: { hash: '', pathname: '/' }, history: { replaceState: vi.fn() },
      sessionStorage: { getItem: (id: string) => storage.get(id), setItem: (id: string, value: string) => storage.set(id, value), removeItem: (id: string) => storage.delete(id) },
      document: { getElementById: get, hidden: false }, window: { addEventListener: (name: string, handler: () => void) => events.set(name, handler) }, fetch, setTimeout: vi.fn(), clearTimeout: vi.fn(),
    })
    new Script(script()).runInContext(context)
    expect(get('join').hidden).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    get('join-name').value = 'Guest'
    const submit = get('join').addEventListener.mock.calls.find(([event]) => event === 'submit')![1]
    await submit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/join', '/state'])
    expect(storage.get('cuedeck-key')).toBe(key)
    expect(get('next').disabled).toBe(true)
    expect(get('join').hidden).toBe(true)
    const nextKey = 'n'.repeat(43)
    context.location.hash = '#key=' + nextKey
    events.get('hashchange')!()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(fetch.mock.calls[2][1]?.headers?.Authorization).toBe('Bearer ' + nextKey)
    expect(storage.get('cuedeck-key')).toBe(nextKey)
  })
})
