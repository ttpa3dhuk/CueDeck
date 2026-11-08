import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { PreparationUiState } from '../src/main/preparation-ui-state'
import type { PlaylistEntry } from '../src/shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const entry = (id: string, path: string, kind: PlaylistEntry['kind'] = 'pptx'): PlaylistEntry => ({
  id, kind, filePath: path, fileName: path, displayName: '', speakerName: '', durationMs: 0,
})

describe('preparation UI state', () => {
  it('never shows queued/preparing while a cached result is being read', async () => {
    const store = new StateStore()
    const patches: unknown[] = []
    const patch = store.patch.bind(store)
    vi.spyOn(store, 'patch').mockImplementation(value => { patches.push(value.preparations); patch(value) })
    const pending = deferred<string>()
    const tracker = new PreparationUiState(store, () => pending.promise, vi.fn())
    const result = tracker.prepare('/cached.pptx')
    expect(store.get().preparations['/cached.pptx']).toBeUndefined()
    pending.resolve('from disk')
    await result
    expect(patches).toEqual([{ '/cached.pptx': { phase: 'ready' } }])
  })
  it('reports background font metadata before ready without loading either deck', async () => {
    const store = new StateStore()
    const before = store.get()
    const pending = deferred<{ fonts: string[] }>()
    const accepted = vi.fn((path: string, result: { fonts: string[] }) => {
      expect(store.get().preparations[path].phase).toBe('queued')
      store.patch({ fontIssues: { ...store.get().fontIssues, [path]: result.fonts } })
    })
    const tracker = new PreparationUiState(store, () => pending.promise, vi.fn(), accepted)
    tracker.background([entry('a', '/a.pptx')], null)
    tracker.phase('/a.pptx', { phase: 'queued' })
    pending.resolve({ fonts: ['Missing Test Font'] })
    await pending.promise; await Promise.resolve()
    expect(accepted).toHaveBeenCalledOnce()
    expect(store.get().fontIssues['/a.pptx']).toEqual(['Missing Test Font'])
    expect(store.get().preparations['/a.pptx'].phase).toBe('ready')
    expect(store.get().preview).toBe(before.preview)
    expect(store.get().pdfPath).toBe(before.pdfPath)
  })

  it('accepts refreshed font metadata but never publishes removed or superseded results', async () => {
    const store = new StateStore()
    const first = deferred<string>(), second = deferred<string>(), third = deferred<string>()
    const prepare = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    const accepted = vi.fn()
    const tracker = new PreparationUiState(store, prepare, vi.fn(), accepted)
    const old = tracker.prepare('/a.pptx')
    const current = tracker.prepare('/a.pptx', { forceLocalCache: true })
    second.resolve('new fonts'); await current
    first.resolve('stale fonts'); await old
    expect(accepted).toHaveBeenCalledExactlyOnceWith('/a.pptx', 'new fonts', { forceLocalCache: true })
    const removed = tracker.prepare('/b.pptx')
    tracker.forget('/b.pptx')
    third.resolve('removed fonts'); await removed
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('does not report font metadata after replacing the project or a failed preparation', async () => {
    const store = new StateStore()
    const pending = deferred<string>()
    const accepted = vi.fn()
    const tracker = new PreparationUiState(store, () => pending.promise, vi.fn(), accepted)
    const old = tracker.prepare('/a.pptx')
    tracker.reset()
    pending.resolve('old fonts')
    await expect(old).rejects.toThrow('cancelled')
    expect(accepted).not.toHaveBeenCalled()
    const failed = new PreparationUiState(store, () => Promise.reject(new Error('bad file')), vi.fn(), accepted)
    await expect(failed.prepare('/a.pptx')).rejects.toThrow('bad file')
    expect(accepted).not.toHaveBeenCalled()
  })

  it('does not resurrect an old card after deleting and re-adding the same path', async () => {
    const store = new StateStore()
    const old = deferred<string>(), current = deferred<string>()
    const prepare = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const tracker = new PreparationUiState(store, prepare, vi.fn())
    const first = tracker.prepare('/a.pptx')
    tracker.forget('/a.pptx')
    const second = tracker.prepare('/a.pptx')
    current.resolve('current'); await second
    old.reject(new Error('deleted card'))
    await expect(first).rejects.toThrow('deleted card')
    expect(store.get().preparations['/a.pptx']).toEqual({ phase: 'ready' })
  })
  it('starts unique presentations on add, without staging or taking any material', async () => {
    const store = new StateStore()
    store.patch({ pdfPath: '/playing.mp4', fileKind: 'video' })
    const before = store.get()
    const pending = deferred<string>()
    const prepare = vi.fn(() => pending.promise)
    const tracker = new PreparationUiState(store, prepare, vi.fn())
    tracker.background([entry('a', '/a.pptx'), entry('duplicate', '/a.pptx'), entry('b', '/b.pdf', 'pdf')], '/show.pdpres')
    expect(prepare).toHaveBeenCalledExactlyOnceWith('/a.pptx', { priority: 'background', cacheProjectPath: '/show.pdpres' })
    expect(store.get().preparations['/a.pptx']).toBeUndefined()
    tracker.phase('/a.pptx', { phase: 'queued' })
    expect(store.get().preparations['/a.pptx']).toEqual({ phase: 'queued' })
    tracker.phase('/a.pptx', { phase: 'preparing' })
    expect(store.get().preparations['/a.pptx'].phase).toBe('preparing')
    pending.resolve('ready')
    await pending.promise; await Promise.resolve()
    expect(store.get().preparations['/a.pptx'].phase).toBe('ready')
    expect(store.get().pdfPath).toBe(before.pdfPath)
    expect(store.get().preview).toBe(before.preview)
    expect(store.get().video).toBe(before.video)
    expect(store.get().timer).toBe(before.timer)
    expect(store.get().testScreen).toBe(before.testScreen)
  })

  it('reports errors per file and accepts a retry after failure', async () => {
    const store = new StateStore()
    const prepare = vi.fn().mockRejectedValueOnce(new Error('bad archive')).mockResolvedValueOnce('ready')
    const tracker = new PreparationUiState(store, prepare, vi.fn())
    await expect(tracker.prepare('/bad.pptx')).rejects.toThrow('bad archive')
    expect(store.get().preparations['/bad.pptx']).toEqual({ phase: 'error', error: 'bad archive' })
    await expect(tracker.prepare('/bad.pptx', { forceLocalCache: true })).resolves.toBe('ready')
    expect(store.get().preparations['/bad.pptx']).toEqual({ phase: 'ready' })
  })

  it('rejects an old project result and ignores its terminal notifications', async () => {
    const store = new StateStore()
    const pending = deferred<string>()
    const cancel = vi.fn()
    const tracker = new PreparationUiState(store, () => pending.promise, cancel)
    const old = tracker.prepare('/a.pptx')
    tracker.reset()
    expect(cancel).toHaveBeenCalledOnce()
    tracker.phase('/a.pptx', { phase: 'ready' })
    tracker.phase('/a.pptx', { phase: 'preparing' })
    pending.resolve('old project')
    await expect(old).rejects.toThrow('cancelled')
    expect(store.get().preparations).toEqual({})
  })

  it('does not let an older request overwrite the newer retry status', async () => {
    const store = new StateStore()
    const first = deferred<string>(), second = deferred<string>()
    const prepare = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const tracker = new PreparationUiState(store, prepare, vi.fn())
    const old = tracker.prepare('/a.pptx')
    const current = tracker.prepare('/a.pptx', { forceLocalCache: true })
    second.resolve('new'); await current
    first.reject(new Error('stale'))
    await expect(old).rejects.toThrow('stale')
    expect(store.get().preparations['/a.pptx']).toEqual({ phase: 'ready' })
  })
})
