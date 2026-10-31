import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ModuleInstance from '../companion-module/src/main'
import { DEFAULT_CONFIG, GetConfigFields } from '../companion-module/src/config'

const state = { app: 'CueDeck', version: 'test', timer: { running: false } }
const firstKey = 'a'.repeat(64)
const secondKey = 'b'.repeat(64)
const okState = () => ({ ok: true, status: 200, json: async () => state }) as Response
const okCommand = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response

type TestInstance = Omit<ModuleInstance, never> & {
  poll: (gen: number) => Promise<void>
  generation: number
  stop: () => void
  setState: (state: unknown) => void
}

function instance(): TestInstance {
  // Companion's SDK constructor requires its host. Exercise the module methods
  // with a minimal instance; the SDK's own storage is covered by its contract.
  const item = Object.create(ModuleInstance.prototype) as TestInstance
  Object.assign(item, {
    config: { ...DEFAULT_CONFIG }, state: null, pollTimer: null, generation: 0,
    fails: 0, lastValues: new Map(), varShape: '', lastError: '',
    reqSeq: 0, appliedSeq: 0, accessKey: '',
    updateStatus: vi.fn(), log: vi.fn(),
  })
  vi.spyOn(item, 'updateActions').mockImplementation(() => {})
  vi.spyOn(item, 'updateFeedbacks').mockImplementation(() => {})
  vi.spyOn(item, 'updatePresets').mockImplementation(() => {})
  vi.spyOn(item, 'updateVariableDefinitions').mockImplementation(() => {})
  vi.spyOn(item, 'setState').mockImplementation(next => { item.state = next as typeof item.state })
  return item
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Companion connection key', () => {
  it('keeps legacy config working without secrets', async () => {
    const item = instance()
    const fetcher = vi.fn().mockResolvedValue(okState())
    vi.stubGlobal('fetch', fetcher)
    await item.init({ host: '127.0.0.1', port: 9420, lang: 'en' }, false, undefined!)
    item.stop()
    await item.poll(item.generation)
    expect(item.state).toEqual(state)
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined()
    expect(item.config.lang).toBe('en')
    await item.destroy()
  })

  it('sends the same bearer header for polling and commands, never in URL', async () => {
    const item = instance()
    const fetcher = vi.fn().mockResolvedValueOnce(okState()).mockResolvedValueOnce(okCommand())
    vi.stubGlobal('fetch', fetcher)
    await item.init(DEFAULT_CONFIG, false, { key: firstKey })
    item.stop()
    await item.poll(item.generation)
    await item.sendCommand({ path: 'timer/start' })
    expect(fetcher.mock.calls.map(call => call[1].headers)).toEqual([
      { Authorization: `Bearer ${firstKey}` },
      { Authorization: `Bearer ${firstKey}` },
    ])
    expect(fetcher.mock.calls.every(call => !String(call[0]).includes(firstKey))).toBe(true)
    await item.destroy()
  })

  it('updates and clears the secret without adding an empty header', async () => {
    const item = instance()
    const fetcher = vi.fn().mockResolvedValue(okCommand())
    vi.stubGlobal('fetch', fetcher)
    await item.init(DEFAULT_CONFIG, false, { key: firstKey })
    await item.sendCommand({ path: 'timer/start' })
    await item.configUpdated(DEFAULT_CONFIG, { key: secondKey })
    await item.sendCommand({ path: 'timer/start' })
    await item.configUpdated(DEFAULT_CONFIG, { key: '' })
    await item.sendCommand({ path: 'timer/start' })
    expect(fetcher.mock.calls.map(call => call[1].headers)).toEqual([
      { Authorization: `Bearer ${firstKey}` },
      { Authorization: `Bearer ${secondKey}` },
      undefined,
    ])
    expect(GetConfigFields().find(field => field.id === 'key')?.type).toBe('secret-text')
    await item.destroy()
  })

  it('does not apply an old poll response after connection config changes', async () => {
    const item = instance()
    let resolveOld!: (response: Response) => void
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(okState())
    vi.stubGlobal('fetch', fetcher)
    await item.init(DEFAULT_CONFIG, false, { key: firstKey })
    item.stop()
    const oldPoll = item.poll(item.generation)
    await item.configUpdated({ ...DEFAULT_CONFIG, host: '192.0.2.2' }, { key: secondKey })
    item.stop()
    await item.poll(item.generation)
    const applied = item.state
    resolveOld({ ...okState(), json: async () => ({ ...state, version: 'old' }) } as Response)
    await oldPoll
    expect(item.state).toBe(applied)
    expect(fetcher.mock.calls[1][1].headers).toEqual({ Authorization: `Bearer ${secondKey}` })
    await item.destroy()
  })

  it('does not apply an old body after the key changes during JSON reading', async () => {
    const item = instance()
    let resolveOldBody!: (body: unknown) => void
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(resolve => { resolveOldBody = resolve }) })
      .mockResolvedValueOnce(okState())
    vi.stubGlobal('fetch', fetcher)
    await item.init(DEFAULT_CONFIG, false, { key: firstKey })
    item.stop()
    const oldPoll = item.poll(item.generation)
    await Promise.resolve()
    expect(resolveOldBody).toBeTypeOf('function')
    await item.configUpdated(DEFAULT_CONFIG, { key: secondKey })
    item.stop()
    await item.poll(item.generation)
    resolveOldBody({ ...state, version: 'old' })
    await oldPoll
    expect(item.state).toEqual(state)
    await item.destroy()
  })

  it.each(['bad-key', `${firstKey}\r\nprivate-value`, firstKey.toUpperCase()])(
    'rejects an invalid secret before fetch without logging its value', async key => {
      const item = instance()
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      await item.init(DEFAULT_CONFIG, false, { key })
      item.stop()
      await item.poll(item.generation)
      await item.sendCommand({ path: 'timer/start' })
      expect(fetcher).not.toHaveBeenCalled()
      const logs = JSON.stringify((item.log as ReturnType<typeof vi.fn>).mock.calls)
      expect(logs).toContain('ключ')
      expect(logs).not.toContain(key)
      expect(logs).not.toContain('private-value')
      await item.destroy()
    },
  )

  it('explains 401 without treating 403 as a bad key', async () => {
    const item = instance()
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: false, status: 403 })
    vi.stubGlobal('fetch', fetcher)
    await item.init(DEFAULT_CONFIG, false, {})
    item.stop()
    await item.poll(item.generation)
    await item.poll(item.generation)
    const logs = (item.log as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1])
    expect(logs[0]).toContain('ключ')
    expect(logs[1]).toContain('Из сети')
    await item.destroy()
  })
})
