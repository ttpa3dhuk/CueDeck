/**
 * Pure, testable lifecycle policy for the dev Syphon helper. The main bridge
 * uses this instead of an unbounded restart loop.
 */
export class RestartBudget {
  private attempts = 0

  constructor(
    private readonly maxAttempts = 4,
    private readonly baseDelayMs = 250,
    private readonly maxDelayMs = 2000,
  ) {}

  get used(): number {
    return this.attempts
  }

  /** Returns the delay for the next restart, or null when the budget is spent. */
  nextDelayMs(): number | null {
    if (this.attempts >= this.maxAttempts) return null
    this.attempts++
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.attempts - 1))
  }

  reset(): void {
    this.attempts = 0
  }
}

/**
 * Bounded latest-state recovery for the audience tap.
 *
 * A new frame can arrive while the helper is still acknowledging the previous
 * one. That frame is dropped before CPU readback. If it was the final static
 * change (for example the end of a TAKE/Fade or a new slide), no further paint
 * event may arrive, so after the matching PUBLISHED ack the bridge must ask
 * Chromium for exactly one fresh frame. The request is armed only by a frame
 * actually skipped while busy; a normal ack never starts an invalidate loop.
 */
export class LatestFrameRecovery {
  private busy = false
  private dirty = false

  /** First frame has been written to the helper. */
  begin(): void {
    this.busy = true
  }

  /** A frame arrived while busy and will be dropped before readback. */
  skippedWhileBusy(): void {
    if (this.busy) this.dirty = true
  }

  /** Matching PUBLISHED ack. Returns true exactly once for the pending change. */
  published(): boolean {
    const request = this.busy && this.dirty
    this.busy = false
    this.dirty = false
    return request
  }

  /** Timeout, helper exit or a non-published ack. Do not request a frame. */
  reset(): void {
    this.busy = false
    this.dirty = false
  }

  get isBusy(): boolean {
    return this.busy
  }

  get hasPendingChange(): boolean {
    return this.dirty
  }
}
