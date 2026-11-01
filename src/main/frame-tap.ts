/**
 * One Electron frame subscription per WebContents, shared by named consumers.
 *
 * Electron 33 has a single `WebContents::frame_subscriber_`: a second
 * `beginFrameSubscription()` replaces the first callback silently. OMT already
 * subscribes directly in `omt/outputs.ts`, so a bridge must not call
 * `beginFrameSubscription()` itself or it would steal OMT's frames.
 *
 * This module is the only place that starts/stops the Electron subscription.
 * Consumers acquire a lease; the last release ends the subscription. A
 * destroyed WebContents is handled without touching Electron again.
 *
 * This module imports Electron types only (no runtime import), so its unit
 * tests run in plain Node with a fake WebContents.
 */
import type { NativeImage, WebContents } from 'electron'

export type FrameTapListener = (image: NativeImage) => void

export interface FrameTapLease {
  readonly owner: string
  release(): void
}

interface TapEntry {
  readonly listeners: Map<string, FrameTapListener>
  readonly onDestroyed: () => void
  destroyed: boolean
}

const taps = new WeakMap<WebContents, TapEntry>()

export function acquireFrameTap(
  wc: WebContents,
  owner: string,
  listener: FrameTapListener,
): FrameTapLease {
  if (!owner) throw new Error('frame tap owner is required')
  if (!listener) throw new Error('frame tap listener is required')
  if (wc.isDestroyed()) throw new Error(`frame tap on destroyed WebContents (${owner})`)

  let entry = taps.get(wc)
  if (entry && entry.destroyed) {
    taps.delete(wc)
    entry = undefined
  }

  if (!entry) {
    const created: TapEntry = {
      listeners: new Map(),
      destroyed: false,
      onDestroyed: () => {
        const current = taps.get(wc)
        if (current !== created) return
        created.destroyed = true
        created.listeners.clear()
        taps.delete(wc)
      },
    }
    taps.set(wc, created)
    try {
      wc.beginFrameSubscription(false, (image) => {
        const current = taps.get(wc)
        if (!current || current.destroyed) return
        // Copy the entries: a listener may release itself during the callback.
        for (const [name, callback] of Array.from(current.listeners.entries())) {
          try {
            callback(image)
          } catch (error) {
            console.warn(`[frame-tap] listener ${name} failed`, error)
          }
        }
      })
      wc.once('destroyed', created.onDestroyed)
    } catch (error) {
      taps.delete(wc)
      throw error
    }
    entry = created
  }

  if (entry.listeners.has(owner)) {
    throw new Error(`frame tap owner already registered: ${owner}`)
  }
  entry.listeners.set(owner, listener)
  const captured = entry
  let released = false
  return {
    owner,
    release: () => {
      if (released) return
      released = true
      const current = taps.get(wc)
      if (current !== captured) return
      current.listeners.delete(owner)
      if (current.listeners.size > 0) return
      taps.delete(wc)
      current.destroyed = true
      wc.removeListener('destroyed', current.onDestroyed)
      if (!wc.isDestroyed()) {
        try {
          wc.endFrameSubscription()
        } catch {
          // The window can disappear between isDestroyed() and the call.
        }
      }
    },
  }
}
