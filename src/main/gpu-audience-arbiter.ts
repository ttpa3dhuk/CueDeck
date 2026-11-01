/**
 * Narrow arbitration between the DEV-ONLY GPU audience producer and consumers
 * that need a normal hidden audience window (stream, OMT program capture,
 * physical layout). No Electron imports, so windows/streamer/OMT can call it
 * without cycles.
 *
 * The GPU producer registers one stop hook. A normal consumer calls
 * stopGpuAudienceForNormalOutput() BEFORE acquiring/creating its own normal
 * hidden audience. Stopping the GPU branch must never disable the normal
 * consumer, release its leases, or throw.
 */
export interface GpuAudienceGuard {
  stop(reason: string): void
}

let guard: GpuAudienceGuard | null = null

export function setGpuAudienceGuard(next: GpuAudienceGuard): void { guard = next }
export function clearGpuAudienceGuard(current: GpuAudienceGuard): void {
  if (guard === current) guard = null
}
export function isGpuAudienceActive(): boolean { return guard !== null }

/**
 * Stop the experimental GPU audience before a normal audience consumer takes
 * over. Returns true when a GPU branch was asked to stop.
 */
export function stopGpuAudienceForNormalOutput(reason: string): boolean {
  const current = guard
  if (!current) return false
  guard = null
  try {
    current.stop(reason)
  } catch {
    // The normal output must still be allowed to proceed. The GPU branch logs
    // its own failure; this hook is deliberately best-effort.
  }
  return true
}
