import type { AppState, Layout, Role, VideoState } from '../../preload/api'

export const MEDIA_SCHEME = 'cuedeck-media'

export type MediaDeck = 'program' | 'preview'

/**
 * URL the <video> element points at. The path lives in main (the active file),
 * so the URL only carries which deck to stream (program = audience feed, preview
 * = operator staging) plus a cache-buster keyed by file identity — changing the
 * latter forces the element to reload when the operator switches videos.
 */
export function videoSrc(sha1: string, deck: MediaDeck = 'program'): string {
  return `${MEDIA_SCHEME}://stream/${deck}?v=${encodeURIComponent(sha1)}`
}

/** Position (seconds) the shared logical clock currently points at. */
export function videoPosition(v: VideoState): number {
  if (v.playing && v.anchorAt != null) {
    const pos = v.anchorSec + (Date.now() - v.anchorAt) / 1000
    return v.durationSec > 0 ? Math.min(pos, v.durationSec) : pos
  }
  return v.anchorSec
}

/**
 * Which role drives audio output: the audience (projector / program feed) when
 * present, otherwise the operator in solo. The speaker monitor is never audible.
 */
export function audioRole(layout: Layout): Role {
  return layout === 'solo' ? 'operator' : 'audience'
}

/**
 * A window outputs sound only if it's the audio role and the mix isn't muted.
 * Blackout is a full kill: it silences the program feed too, so a blacked-out
 * hall never keeps blasting the video's audio (playback itself keeps running —
 * un-blackout brings the sound back at the live position).
 */
export function shouldMute(state: AppState, role: Role): boolean {
  return role !== audioRole(state.layout) || state.video.muted || state.blackout
}

const DEFAULT_DRIFT_SEC = 0.4

/**
 * Reconcile a <video> element with the shared clock: correct large drift with a
 * seek, and match the play/pause state. Small drifts are left alone so we don't
 * fight the element's native playback.
 */
export function syncVideoElement(
  video: HTMLVideoElement,
  v: VideoState,
  driftSec: number = DEFAULT_DRIFT_SEC,
): void {
  const target = videoPosition(v)
  if (Number.isFinite(target) && Math.abs(video.currentTime - target) > driftSec) {
    try {
      video.currentTime = target
    } catch {
      /* element not ready yet — next tick will catch it */
    }
  }
  if (v.playing) {
    if (video.paused) video.play().catch(() => undefined)
  } else if (!video.paused) {
    video.pause()
  }
}

/**
 * Route a media element's sound to a specific output device (sound card,
 * minijack, HDMI to vMix…). `null`/'' → system default. Falls back to default
 * if the chosen device is gone. No-op where setSinkId isn't available.
 */
export async function applySinkId(
  el: HTMLMediaElement,
  deviceId: string | null,
): Promise<void> {
  const sinkEl = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof sinkEl.setSinkId !== 'function') return
  try {
    await sinkEl.setSinkId(deviceId ?? '')
  } catch {
    try {
      await sinkEl.setSinkId('')
    } catch {
      /* element not ready or no permission — ignore */
    }
  }
}

export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
