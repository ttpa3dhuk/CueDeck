import type { AppState, PlaylistEntry } from '../shared/types.js'

type Status = AppState['preparations'][string]
export interface PreparationOptions {
  priority?: 'foreground' | 'background'
  forceLocalCache?: boolean
  cacheSourcePath?: string
  cacheProjectPath?: string | null
  reportFontIssues?: boolean
}
interface PreparationStore {
  get(): AppState
  patch(patch: Partial<AppState>): void
}

/** Presentation work may finish after a project was replaced. Keep its UI scoped. */
export class PreparationUiState<T> {
  private epoch = 0
  private serial = 0
  private versions = new Map<string, number>()

  constructor(
    private readonly store: PreparationStore,
    private readonly prepareFile: (path: string, options: PreparationOptions) => Promise<T>,
    private readonly cancel: () => void,
    private readonly prepared?: (path: string, result: T, options: PreparationOptions) => void,
  ) {}

  private publish(path: string, status: Status): void {
    const states = this.store.get().preparations
    if (states[path]?.phase === status.phase && states[path]?.error === status.error) return
    this.store.patch({ preparations: { ...states, [path]: status } })
  }

  /** Terminal states are accepted only by the promise with the matching epoch. */
  phase(path: string, status: Status): void {
    if ((status.phase === 'queued' || status.phase === 'preparing') && this.versions.has(path)) this.publish(path, status)
  }

  async prepare(path: string, options: PreparationOptions = {}): Promise<T> {
    const epoch = this.epoch
    const version = ++this.serial
    this.versions.set(path, version)
    // The queue checks disk cache before emitting queued. A warm lookup must
    // not look like a fresh conversion or increment the batch counter.
    try {
      const result = await this.prepareFile(path, options)
      if (epoch !== this.epoch) throw new Error('Presentation preparation cancelled')
      if (this.versions.get(path) === version) {
        this.prepared?.(path, result, options)
        this.publish(path, { phase: 'ready' })
      }
      return result
    } catch (error) {
      if (epoch === this.epoch && this.versions.get(path) === version) {
        this.publish(path, { phase: 'error', error: error instanceof Error ? error.message : String(error) })
      }
      throw error
    }
  }

  background(entries: readonly PlaylistEntry[], projectPath: string | null): void {
    for (const path of new Set(entries.filter(e => e.kind === 'pptx').map(e => e.filePath))) {
      // A failed card remains retryable; background errors must not change the feed.
      void this.prepare(path, { priority: 'background', cacheProjectPath: projectPath }).catch(() => undefined)
    }
  }

  reset(): void {
    this.epoch++
    this.versions.clear()
    this.cancel()
    this.store.patch({ preparations: {} })
  }

  forget(path: string): void {
    this.versions.delete(path)
    const statuses = { ...this.store.get().preparations }
    delete statuses[path]
    this.store.patch({ preparations: statuses })
  }
}
