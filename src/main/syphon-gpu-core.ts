/** Small pure pieces shared by the in-process GPU probe and its tests. */
export const GPU_PIXEL_BGRA = 1
export const GPU_PIXEL_RGBA = 2

/** Electron 33 exposes a flat handle; 44 uses a platform-specific handle object. */
export function sharedGpuHandle(info: unknown, platform: NodeJS.Platform): Buffer | null {
  if (!info || typeof info !== 'object') return null
  const value = info as { sharedTextureHandle?: unknown; handle?: { ntHandle?: unknown; ioSurface?: unknown } }
  const handle = (platform === 'win32' ? value.handle?.ntHandle : value.handle?.ioSurface)
    ?? value.sharedTextureHandle
  return Buffer.isBuffer(handle) && handle.length === 8 && handle.readBigUInt64LE() !== 0n ? handle : null
}

export class GpuSendGate {
  private ready = false
  private inFlight = false
  markReady(): void { this.ready = true }
  markDead(): void { this.ready = false; this.inFlight = false }
  canSend(): boolean { return this.ready && !this.inFlight }
  begin(): boolean { if (!this.canSend()) return false; this.inFlight = true; return true }
  ack(): void { this.inFlight = false }
  timeout(): void { this.inFlight = false }
  isInFlight(): boolean { return this.inFlight }
  isReady(): boolean { return this.ready }
}
