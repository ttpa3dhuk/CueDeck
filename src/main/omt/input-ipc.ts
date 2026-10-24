import { gpuFrameApi, importGpuFrame } from './gpu-import.js'
import { app, ipcMain, MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { join } from 'node:path'
import { libDir } from './libomt.js'
import { logsDir } from '../diag.js'
import log from 'electron-log/main'
import { validOmtAddress } from '../../shared/omt-input.js'

interface Consumer { wc: WebContents; addresses: string[]; worker?: UtilityProcess }

/** Main carries control only. Raw frames travel utility-process → renderer ports. */
export function registerOmtInputIpc(): void {
  const consumers = new Map<number, Consumer>()
  const watched = new WeakSet<WebContents>()
  const requests = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let child: UtilityProcess | undefined
  let sequence = 0
  let portGeneration = 0
  let stopped = false
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let crashes: number[] = []
  const errorFor = (consumer: Consumer, message: string): void => {
    if (!consumer.wc.isDestroyed()) consumer.wc.send('omt-input:error', { addresses: consumer.addresses, message })
  }
  const request = (worker: UtilityProcess, message: object): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('OMT input worker timed out')) }, 8000)
    requests.set(id, { resolve, reject, timer })
    try { worker.postMessage({ ...message, request: id }) }
    catch (error) { clearTimeout(timer); requests.delete(id); reject(error) }
  })
  const connect = (worker: UtilityProcess, consumer: Consumer): void => {
    const { port1, port2 } = new MessageChannelMain()
    try {
      worker.postMessage({ type: 'connect', consumer: consumer.wc.id, sequenceBase: ++portGeneration * 1_000_000_000 }, [port1])
      consumer.wc.postMessage('omt-input:port', null, [port2])
      consumer.worker = worker
    } catch (error) { port1.close(); port2.close(); throw error }
  }
  const start = (): UtilityProcess => {
    if (stopped) throw new Error('OMT input is shutting down')
    if (child) return child
    // Koffi loads vendor dylibs inside the helper, with no global Node-mode override.
    const worker = utilityProcess.fork(join(__dirname, 'input-worker.js'), [libDir(), join(logsDir(), 'omt-input.log'), ...(gpuFrameApi() ? ['--gpu-share'] : [])], {
      serviceName: 'CueDeck OMT Input', allowLoadingUnsignedLibraries: true,
    })
    child = worker
    worker.on('message', message => {
      if (message.type === 'stats') {
        const consumer = consumers.get(message.consumer)
        if (child !== worker || consumer?.worker !== worker || !consumer.addresses.includes(message.address)) return
        log.info(
          `omt input #${message.consumer} «${message.address}»: нативно пришло ${message.rawFrames} аудиокадров, ` + // i18n-ok: журнал
            `макс. пауза между ними ${message.rawMaxGapMs} мс, с последнего кадра ${message.rawSinceLastMs ?? '—'} мс, ` + // i18n-ok: журнал
            `не дошло до окна ${message.dropped}`, // i18n-ok: журнал
        )
        return
      }
      if (message.type === 'gpu-frame') {
        const consumer = consumers.get(message.consumer)
        const wc = child === worker && consumer?.worker === worker && consumer.addresses.includes(message.address) ? consumer.wc : undefined
        void importGpuFrame(worker, wc, message.address, message.frame, () => {
          const current = consumers.get(message.consumer)
          return child === worker && !!wc && !wc.isDestroyed() && current?.worker === worker && current.addresses.includes(message.address)
        })
        return
      }
      const pending = requests.get(message.request)
      if (pending) {
        clearTimeout(pending.timer); requests.delete(message.request)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve(message.result)
      } else if (message.error && consumers.has(message.consumer)) errorFor(consumers.get(message.consumer)!, message.error)
    })
    worker.once('exit', () => {
      if (child !== worker) return
      child = undefined
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('OMT input worker exited')) }
      requests.clear()
      if (stopped) return
      const now = Date.now()
      crashes = crashes.filter(at => now - at < 60000)
      crashes.push(now)
      for (const consumer of consumers.values()) errorFor(consumer, 'OMT input worker exited; reconnecting')
      if (consumers.size && crashes.length <= 3) restartTimer = setTimeout(() => {
        restartTimer = undefined
        try {
          const replacement = start()
          for (const consumer of consumers.values()) {
            if (consumer.wc.isDestroyed()) continue
            connect(replacement, consumer)
            void request(replacement, { type: 'retain', consumer: consumer.wc.id, addresses: consumer.addresses }).catch(error => errorFor(consumer, error.message))
          }
        } catch (error) { for (const consumer of consumers.values()) errorFor(consumer, String(error)) }
      }, 500)
      else if (consumers.size) for (const consumer of consumers.values()) errorFor(consumer, 'OMT input repeatedly failed; select the source again to retry')
    })
    return worker
  }
  const release = (id: number): void => {
    consumers.delete(id)
    child?.postMessage({ type: 'release', consumer: id })
    if (!consumers.size && restartTimer) { clearTimeout(restartTimer); restartTimer = undefined }
  }
  ipcMain.handle('omt-input:discover', () => request(start(), { type: 'discover' }))
  ipcMain.handle('omt-input:retain', async (event, addresses: string[]) => {
    if (!Array.isArray(addresses) || addresses.length > 32 || !addresses.every(validOmtAddress)) throw new Error('Invalid OMT sources')
    const wc = event.sender
    if (!addresses.length) { release(wc.id); return }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined }
    const worker = start()
    let consumer = consumers.get(wc.id)
    if (!consumer) {
      consumer = { wc, addresses: [...new Set(addresses)] }
      consumers.set(wc.id, consumer)
      if (!watched.has(wc)) {
        watched.add(wc)
        wc.once('destroyed', () => release(wc.id))
        wc.on('did-start-loading', () => release(wc.id))
      }
      connect(worker, consumer)
    } else {
      consumer.addresses = [...new Set(addresses)]
      if (consumer.worker !== worker) connect(worker, consumer)
    }
    await request(worker, { type: 'retain', consumer: wc.id, addresses: consumer.addresses })
  })
  app.once('will-quit', () => {
    stopped = true
    if (restartTimer) clearTimeout(restartTimer)
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('OMT input is shutting down')) }
    requests.clear(); consumers.clear()
    child?.postMessage({ type: 'shutdown' })
    child?.kill()
    child = undefined
  })
}
