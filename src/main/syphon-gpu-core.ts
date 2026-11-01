/** Small pure pieces shared by the in-process GPU probe and its tests. */
export const GPU_PIXEL_BGRA = 1
export const GPU_PIXEL_RGBA = 2

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
