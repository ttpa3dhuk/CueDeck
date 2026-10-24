import type { OmtInputFrame, OmtInputPacket } from '../../shared/omt-input.js'

/** Queue limits belong beside the producer, outside Electron's main process. */
export class OmtInputTransport {
  private pending = new Map<number, { address: string; type: OmtInputFrame['type'] }>()
  private addresses = new Set<string>()
  private sequence: number
  private closed = false
  /** Frames dropped because the renderer did not acknowledge its window. */
  droppedVideo = 0
  /** Audio frames dropped before the port: PCM that never reached the renderer. */
  droppedAudio = 0
  constructor(private send: (packet: OmtInputPacket) => void, initialSequence = 0) { this.sequence = initialSequence }
  retain(addresses: string[]): void {
    this.addresses = new Set(addresses)
    for (const [id, packet] of this.pending) if (!this.addresses.has(packet.address)) this.pending.delete(id)
  }
  ack(sequence: unknown): void {
    if (typeof sequence === 'number') this.pending.delete(sequence)
  }
  frame(address: string, frame: OmtInputFrame): void {
    if (this.closed || !this.addresses.has(address)) return
    let outstanding = 0
    for (const packet of this.pending.values()) if (packet.address === address && packet.type === frame.type) outstanding++
    if (outstanding >= (frame.type === 'video' ? 2 : 24)) {
      if (frame.type === 'audio') this.droppedAudio++
      else this.droppedVideo++
      return
    }
    const sequence = ++this.sequence
    this.pending.set(sequence, { address, type: frame.type })
    try { this.send({ address, sequence, frame }) }
    catch (error) { this.pending.delete(sequence); throw error }
  }
  close(): void { this.closed = true; this.pending.clear(); this.addresses.clear() }
}
