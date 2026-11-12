import { programVideoSource, programVideoOwner } from '../shared/program-source.js'
import { ipcMain, MessageChannelMain, type WebContents } from 'electron'
import { store, type WindowKey } from './state.js'

// Windows can share a pressured program decoder; 0 disables it, 1 forces it for QA.
export const programMirrorEnabled = process.platform === 'win32' && process.env.CUEDECK_SHARED_VIDEO !== '0'
const roles: WindowKey[] = ['operator', 'speaker', 'audience', 'gpu-prompter']

export function expectedProgramVideo(): string | null { return programVideoSource(store.get()) }

export function registerProgramMirrorIpc(enabled = programMirrorEnabled): void {
  const entries = new Map<number, { wc: WebContents; key: string }>()
  const attached = new WeakSet<WebContents>()
  const links = new Map<number, { source: WebContents; target: WebContents; key: string; id: number }>()
  let serial = 0
  const send = (wc: WebContents, channel: string, value: unknown): void => {
    if (!wc.isDestroyed()) { try { wc.send(channel, value) } catch { /* navigation/close */ } }
  }
  const rebuild = (): void => {
    // Solo can have a hidden network output whose audio owner changes at runtime.
    // Keep that existing routing native until it has its own A/V acceptance.
    const key = store.get().layout === 'solo' ? null : expectedProgramVideo()
    const owner = store.registeredWindow(programVideoOwner(store.get()))?.webContents
    for (const [id, link] of links) {
      if (!key || key !== link.key || owner !== link.source || owner.isDestroyed() ||
          link.target.isDestroyed() || entries.get(id)?.key !== key || entries.get(owner.id)?.key !== key) {
        send(link.source, 'program-mirror:reset', { key: link.key, id: link.id })
        send(link.target, 'program-mirror:reset', { key: link.key, id: link.id })
        links.delete(id)
      }
    }
    if (!key || !owner || owner.isDestroyed() || entries.get(owner.id)?.key !== key) return
    for (const [id, entry] of entries) {
      if (id === owner.id || entry.key !== key || entry.wc.isDestroyed() || links.has(id)) continue
      if (!roles.some(role => store.registeredWindow(role)?.webContents === entry.wc)) continue
      const connection = ++serial, { port1, port2 } = new MessageChannelMain()
      try {
        owner.postMessage('program-mirror:port', { key, id: connection, mode: 'source' }, [port1])
        entry.wc.postMessage('program-mirror:port', { key, id: connection, mode: 'consumer' }, [port2])
        links.set(id, { source: owner, target: entry.wc, key, id: connection })
      } catch {
        for (const port of [port1, port2]) { try { port.close() } catch { /* already transferred */ } }
        send(owner, 'program-mirror:reset', { key, id: connection })
        send(entry.wc, 'program-mirror:reset', { key, id: connection })
      }
    }
  }
  ipcMain.handle('program-mirror:available', event => enabled &&
    roles.some(role => store.registeredWindow(role)?.webContents === event.sender))
  ipcMain.handle('program-mirror:forced', event => enabled && process.env.CUEDECK_SHARED_VIDEO === '1' &&
    roles.some(role => store.registeredWindow(role)?.webContents === event.sender))
  ipcMain.on('program-mirror:register', (event, source: unknown) => {
    if (!enabled || event.senderFrame !== event.sender.mainFrame ||
      !roles.some(role => store.registeredWindow(role)?.webContents === event.sender)) return
    if (source !== null && (typeof source !== 'string' || source !== expectedProgramVideo())) return
    if (source === null) entries.delete(event.sender.id)
    else entries.set(event.sender.id, { wc: event.sender, key: source })
    if (!attached.has(event.sender)) {
      attached.add(event.sender)
      const id = event.sender.id
      const drop = (): void => { entries.delete(id); rebuild() }
      event.sender.once('destroyed', drop)
      event.sender.on('did-start-loading', drop)
    }
    rebuild()
  })
  if (enabled) store.onChange(rebuild)
}
