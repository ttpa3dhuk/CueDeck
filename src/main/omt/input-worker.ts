import { constants, getPriority, setPriority } from 'node:os'
import { OmtGpuFrames } from './gpu-frames.js'
import { OmtInputManager } from './inputs.js'
import { createOmtLibrary, type OmtLib } from './libomt-native.js'
import { OmtInputTransport } from './input-transport.js'
import { validOmtAddress } from '../../shared/omt-input.js'

// Windows may start Electron utility processes at BelowNormal. This helper
// consumes real-time PCM; restore ordinary scheduling before receiving frames.
if (process.platform === 'win32') {
  try {
    if (getPriority() > constants.priority.PRIORITY_NORMAL) setPriority(constants.priority.PRIORITY_NORMAL)
  } catch (error) { console.warn('[OMT input] could not restore normal process priority:', error) }
}

// UtilityProcess parentPort delivers {data, ports}, unlike worker_threads.
const parent = process.parentPort!
let library: OmtLib | undefined
let gpu: OmtGpuFrames | undefined
if (process.platform === 'win32' && process.argv.includes('--gpu-share')) {
  try { gpu = new OmtGpuFrames() } catch (error) { console.warn('[OMT GPU] unavailable:', error) }
}
const manager = new OmtInputManager(() => library ??= createOmtLibrary(process.argv[2], process.argv[3]), message => console.warn(message), (frame, address) => {
  try { return gpu?.create(frame, address) } catch (error) { gpu?.disable(); console.warn('[OMT GPU] disabled:', error); return undefined }
}, frame => gpu?.discardUnused(frame))
interface ConsumerStats {
  /** Audio frames that could not be posted (renderer ACK window full), by address; `seen` makes the delta per address. */
  dropped: Map<string, { total: number; seen: number }>
  /** Raw libomt frames received from the source natively, by address (arrival intervals). */
  raw: Map<string, { frames: number; maxGapMs: number; lastAt: number }>
}
const consumers = new Map<number, { port: Electron.MessagePortMain; flow: OmtInputTransport; stats: ConsumerStats }>()
const release = (id: number): void => {
  const consumer = consumers.get(id)
  consumers.delete(id)
  consumer?.flow.close()
  consumer?.port.close()
  manager.release(id)
}
parent.on('message', (event) => {
  const message = event.data
  try {
    if (message.type === 'gpu-release') { gpu?.release(message.id); return }
    if (message.type === 'gpu-disable') { gpu?.disable(); return }
    if (message.type === 'connect') {
      release(message.consumer)
      const port = event.ports[0]
      if (!port) throw new Error('Missing OMT input port')
      const stats: ConsumerStats = { dropped: new Map(), raw: new Map() }
      const flow = new OmtInputTransport(packet => {
        if (packet.frame.type === 'video' && packet.frame.texture) {
          gpu!.retain(packet.frame.texture.id)
          try { parent.postMessage({ type: 'gpu-frame', consumer: message.consumer, address: packet.address, frame: packet.frame }) }
          catch (error) { gpu!.release(packet.frame.texture.id); throw error }
          // No ACK capacity is held for tiny descriptors; texture lifetime has its own bounded pool.
          queueMicrotask(() => flow.ack(packet.sequence))
        } else port.postMessage(packet)
      }, message.sequenceBase ?? 0)
      consumers.set(message.consumer, { port, flow, stats })
      port.on('message', event => {
        if (event.data?.type === 'ack') flow.ack(event.data.sequence)
      })
      port.on('close', () => {
        if (consumers.get(message.consumer)?.port === port) release(message.consumer)
      })
      port.start()
    } else if (message.type === 'retain') {
      if (!Array.isArray(message.addresses) || message.addresses.length > 32 || !message.addresses.every(validOmtAddress)) throw new Error('Invalid OMT sources')
      const consumer = consumers.get(message.consumer)
      if (!consumer) throw new Error('OMT renderer disconnected')
      const { flow, stats } = consumer
      const desired = new Set<string>(message.addresses)
      for (const address of stats.raw.keys()) if (!desired.has(address)) stats.raw.delete(address)
      for (const address of stats.dropped.keys()) if (!desired.has(address)) stats.dropped.delete(address)
      manager.retain(message.consumer, message.addresses, (address, frame) => {
        const before = flow.droppedAudio
        flow.frame(address, frame)
        if (flow.droppedAudio !== before) {
          const entry = stats.dropped.get(address) ?? { total: 0, seen: 0 }
          entry.total++
          stats.dropped.set(address, entry)
        }
        if (frame.type === 'audio') {
          // Arrival of raw native audio, not of what the renderer accepted.
          const now = Date.now()
          const raw = stats.raw.get(address) ?? { frames: 0, maxGapMs: 0, lastAt: 0 }
          if (raw.lastAt) raw.maxGapMs = Math.max(raw.maxGapMs, now - raw.lastAt)
          raw.lastAt = now
          raw.frames++
          stats.raw.set(address, raw)
        }
      })
      flow.retain(message.addresses)
    } else if (message.type === 'release') release(message.consumer)
    else if (message.type === 'discover') {
      parent.postMessage({ request: message.request, result: manager.discover() })
      return
    } else if (message.type === 'shutdown') {
      clearInterval(statsTimer)
      for (const id of consumers.keys()) release(id)
      manager.destroy()
      gpu?.close()
      return
    } else throw new Error('Unknown OMT input command')
    if (message.request) parent.postMessage({ request: message.request, result: null })
  } catch (error) {
    parent.postMessage({ request: message.request, consumer: message.consumer, error: String(error instanceof Error ? error.message : error) })
  }
})

/** Arrival cadence and transport loss; neither proves native PCM was continuous. */
const statsTimer = setInterval(() => {
  const now = Date.now()
  for (const [id, consumer] of consumers) {
    const addresses = new Set([...consumer.stats.raw.keys(), ...consumer.stats.dropped.keys()])
    for (const address of addresses) {
      const raw = consumer.stats.raw.get(address)
      const dropped = consumer.stats.dropped.get(address)
      parent.postMessage({
        type: 'stats',
        consumer: id,
        address,
        rawFrames: raw?.frames ?? 0,
        rawMaxGapMs: Math.round(raw?.maxGapMs ?? 0),
        rawSinceLastMs: raw?.lastAt ? now - raw.lastAt : null,
        dropped: dropped ? dropped.total - dropped.seen : 0,
      })
      if (raw) { raw.frames = 0; raw.maxGapMs = 0 }
      if (dropped) dropped.seen = dropped.total
    }
  }
}, 10_000)
;(statsTimer as { unref?: () => void }).unref?.()
