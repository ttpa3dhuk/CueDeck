import { adjustPatch } from '../renderer/shared/timer.js'
import { audienceTimerAction, audienceTimerConfig, type AudienceTimerConfig } from '../shared/audience-timer.js'
import type { StateStore } from './state.js'

export function createAudienceTimerCommands(
  store: Pick<StateStore, 'get' | 'patch'>,
  persist: (config: AudienceTimerConfig) => void,
) {
  return {
    tick(now = Date.now()): void {
      const timer = store.get().audienceTimer
      if (!timer.loop || timer.mode !== 'countdown' || !timer.running || timer.startedAt === null || timer.durationMs <= 0) return
      const elapsed = timer.elapsedMs + Math.max(0, now - timer.startedAt)
      if (elapsed < timer.durationMs) return
      const cycles = Math.floor(elapsed / timer.durationMs)
      store.patch({ audienceTimer: { ...timer, startedAt: now,
        elapsedMs: elapsed % timer.durationMs, cycles: timer.cycles + cycles } })
    },
    action(action: 'start' | 'pause' | 'reset'): void {
      store.patch({ audienceTimer: audienceTimerAction(store.get().audienceTimer, action) })
    },
    adjust(deltaMs: unknown, now = Date.now()): void {
      if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs)) return
      const timer = store.get().audienceTimer
      const patch = adjustPatch(timer, timer.mode, deltaMs, now)
      if (!patch) return
      const next = { ...timer, ...patch }
      const config = audienceTimerConfig(next)
      store.patch({ audienceTimer: { ...next, ...config } })
      if (patch.durationMs !== undefined) persist(config)
    },
    setVisible(visible: unknown): void {
      if (typeof visible === 'boolean') store.patch({ audienceTimer: { ...store.get().audienceTimer, visible } })
    },
    configure(config: unknown): void {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return
      const timer = store.get().audienceTimer
      const clean = audienceTimerConfig({ ...timer, ...config })
      store.patch({ audienceTimer: { ...timer, ...clean } })
      persist(clean)
    },
  }
}
