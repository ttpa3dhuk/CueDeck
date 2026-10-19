import type { FileKind } from '../shared/types'

/** Read PROGRAM at keypress time: a clicker must never seek or start a standalone clip. */
export function createClickerNavigation(
  getKind: () => FileKind | null,
  next: () => void | Promise<void>,
  prev: () => void | Promise<void>,
): { next: () => void | Promise<void>; prev: () => void | Promise<void> } {
  return {
    next: () => { if (getKind() !== 'video') return next() },
    prev: () => { if (getKind() !== 'video') return prev() },
  }
}
