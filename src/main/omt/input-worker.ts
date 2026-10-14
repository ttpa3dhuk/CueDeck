import { OmtGpuFrames } from './gpu-frames.js'
import { OmtInputManager } from './inputs.js'
import { createOmtLibrary, type OmtLib } from './libomt-native.js'
import { OmtInputTransport } from './input-transport.js'
import { validOmtAddress } from '../../shared/omt-input.js'

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
const consumers = new Map<number, { port: Electron.MessagePortMain; flow: OmtInputTransport }>()
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
      const flow = new OmtInputTransport(packet => {
        if (packet.frame.type === 'video' && packet.frame.texture) {
          gpu!.retain(packet.frame.texture.id)
          try { parent.postMessage({ type: 'gpu-frame', consumer: message.consumer, address: packet.address, frame: packet.frame }) }
          catch (error) { gpu!.release(packet.frame.texture.id); throw error }
          // No ACK capacity is held for tiny descriptors; texture lifetime has its own bounded pool.
          queueMicrotask(() => flow.ack(packet.sequence))
        } else port.postMessage(packet)
      }, message.sequenceBase ?? 0)
      consumers.set(message.consumer, { port, flow })
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
      manager.retain(message.consumer, message.addresses, (address, frame) => consumer.flow.frame(address, frame))
      consumer.flow.retain(message.addresses)
    } else if (message.type === 'release') release(message.consumer)
    else if (message.type === 'discover') {
      parent.postMessage({ request: message.request, result: manager.discover() })
      return
    } else if (message.type === 'shutdown') {
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
