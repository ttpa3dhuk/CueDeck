/** One outstanding bitmap per receiver. A slow window cannot queue video forever. */
export class BitmapCredit<T extends { close(): void }> {
  private next = 0
  private pending: number | null = null
  private closed = false

  get busy(): boolean { return this.pending !== null }

  async offer(make: () => Promise<T>, send: (frame: T, sequence: number) => void,
    failed: (error: unknown) => void): Promise<boolean> {
    if (this.closed || this.pending !== null) return false
    const sequence = ++this.next
    this.pending = sequence
    let frame: T | undefined
    try {
      frame = await make()
      if (this.closed || this.pending !== sequence) { frame.close(); return false }
      send(frame, sequence)
      return true // Ownership now belongs to the receiver.
    } catch (error) {
      frame?.close()
      if (!this.closed && this.pending === sequence) {
        this.pending = null
        failed(error)
      }
      return false
    }
  }

  acknowledge(sequence: number): void {
    if (sequence === this.pending) this.pending = null
  }

  close(): void { this.closed = true; this.pending = null }
}
