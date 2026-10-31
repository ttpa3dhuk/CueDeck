import type { VideoDeck, VideoRangeEdge } from '../../shared/types'

export interface FrameStepKeyInput {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** Deck whose player/stage currently owns focus, if any. */
  focusedDeck: VideoDeck | null
  hasProgramVideo: boolean
  hasPreviewVideo: boolean
}

/**
 * Left/Right step a frame only when the focused surface is a video player.
 * Returning null leaves the existing slide/clicker hotkeys completely alone;
 * a real deck result tells the caller to stop propagation before those fire.
 */
export function resolveFrameStepDeck(input: FrameStepKeyInput): VideoDeck | null {
  if (input.code !== 'ArrowLeft' && input.code !== 'ArrowRight') return null
  if (input.ctrlKey || input.metaKey || input.altKey || input.shiftKey) return null
  if (!input.focusedDeck) return null
  if (input.focusedDeck === 'program') return input.hasProgramVideo ? 'program' : null
  return input.hasPreviewVideo ? 'preview' : null
}

export interface RangeKeyInput extends Omit<FrameStepKeyInput, 'code'> {
  code: string
}

/**
 * I / O set In / Out at the playhead, again only when a video player owns focus.
 * Keeping this in the same pure contract as frame stepping makes the focus
 * boundary testable and prevents accidental edits while slides/typing are active.
 */
export function resolveRangeActionForKey(input: RangeKeyInput): { deck: VideoDeck; edge: VideoRangeEdge } | null {
  if (input.ctrlKey || input.metaKey || input.altKey || input.shiftKey) return null
  if (!input.focusedDeck) return null
  const deck = input.focusedDeck === 'program'
    ? (input.hasProgramVideo ? 'program' : null)
    : (input.hasPreviewVideo ? 'preview' : null)
  if (!deck) return null
  if (input.code === 'KeyI') return { deck, edge: 'in' }
  if (input.code === 'KeyO') return { deck, edge: 'out' }
  return null
}
