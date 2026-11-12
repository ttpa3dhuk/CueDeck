import type { AppState } from '../../shared/types'

/** Count only the current batch, excluding previously prepared presentations. */
export class PreparationProgress {
  private paths = new Set<string>()

  update(statuses: AppState['preparations']): { ready: number; total: number } | null {
    const active = Object.keys(statuses).filter(path =>
      statuses[path].phase === 'queued' || statuses[path].phase === 'preparing')
    if (!active.length) {
      this.paths.clear()
      return null
    }
    for (const path of active) this.paths.add(path)
    for (const path of this.paths) if (!statuses[path]) this.paths.delete(path)
    return {
      ready: [...this.paths].filter(path => statuses[path].phase === 'ready').length,
      total: this.paths.size,
    }
  }
}
