import { MobileClicker } from './mobile-clicker.js'
import { setLang } from '../shared/i18n.js'
import type { MobileClickerSnapshot } from '../shared/mobile-clicker.js'

const parent = process.parentPort!
let snapshot: MobileClickerSnapshot = { current: 0, total: 0, remaining: 0, canNavigate: false, timer: { text: '--:--', color: 'neutral' } }
let updated = 0
let epoch = 0
let sequence = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
function ask(type: string, data: unknown): Promise<any> {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Main process unavailable')) }, 3000)
    pending.set(id, { resolve, reject, timer }); parent.postMessage({ type, id, data })
  })
}
const server = new MobileClicker(() => ({ ...snapshot, canNavigate: snapshot.canNavigate && Date.now() - updated < 1500 }),
  direction => ask('command', { direction, presentationId: snapshot.presentationId, epoch }), undefined, undefined,
  { load: () => ask('load', null), save: record => ask('save', record) })
parent.on('message', async ({ data: message }) => {
  if (message.type === 'snapshot') { snapshot = message.data; updated = Date.now(); epoch = message.epoch; setLang(message.lang); return }
  if (message.type === 'reply') {
    const item = pending.get(message.id)
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(Error(message.error)) : item.resolve(message.data) }
    return
  }
  const methods = {
    status: () => server.status(), enabled: () => server.setEnabled(message.args[0]), reset: () => server.resetLink(),
    qr: () => server.qr(message.args[0]), configure: () => server.configure(message.args[0], message.args[1]),
    createGrant: () => server.createGrant(message.args[0], message.args[1]), revokeGrant: () => server.revokeGrant(message.args[0]),
    updateGrant: () => server.updateGrant(message.args[0], message.args[1]),
    connectionProbe: () => server.connectionProbe(), clearProbe: () => server.clearProbe(),
    blockClient: () => server.blockClient(message.args[0], message.args[1]), invitation: () => server.invitation(message.args[0]),
    approveClient: () => server.approveClient(message.args[0], message.args[1]), disconnectClient: () => server.disconnectClient(message.args[0]),
    guestAccess: () => server.setGuestAccess(message.args[0] === true, message.args[1]),
  }
  try {
    const method = methods[message.method as keyof typeof methods]
    if (!method) throw Error('Unknown clicker operation')
    parent.postMessage({ type: 'result', id: message.id, data: await method() })
  } catch (error) { parent.postMessage({ type: 'result', id: message.id, error: String(error) }) }
})
