/** A requested slide is ready only after its newest draw has completed. */
export class SlidePaintTracker {
  private requested = 0
  private painted = 0
  get pending(): boolean { return this.requested !== this.painted }
  begin(): number { return ++this.requested }
  finish(request: number): boolean {
    if (request !== this.requested) return false
    this.painted = request
    return true
  }
}

/** A PDF poster is not the new video frame. Decoder failure may use its poster. */
export function overlayFrameReady(expected: string, loaded: string | null, failed: string | null, readyState: number, seeking: boolean): boolean {
  return failed === expected || (loaded === expected && readyState >= 2 && !seeking)
}
