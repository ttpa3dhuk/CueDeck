// Run after npm run build: node scripts/mobile-clicker-electron-qa.cjs
// Uses isolated, in-memory credentials; never connects to a public tunnel.
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')
const assert = require('node:assert/strict')
const root = join(__dirname, '..')
const artifacts = join(root, 'generated/mobile-clicker-qa')
let service
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function run() {
  const { buildSync } = require('esbuild')
  require('node:fs').mkdirSync(artifacts, { recursive: true })
  const entry = join(artifacts, 'mobile-clicker-service-qa.cjs')
  const packaged = process.argv.find(arg => arg.startsWith('--packaged='))?.slice('--packaged='.length)
  const workerRoot = packaged ? join(root, packaged, 'resources/app.asar/out/main') : join(root, 'out/main')
  buildSync({ entryPoints: [join(root, 'src/main/mobile-clicker-service.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], define: { __dirname: JSON.stringify(workerRoot) } })
  const { MobileClickerService } = require(entry)
  let saved = null; let commands = 0; let deck = 'deck-a'
  service = new MobileClickerService(() => ({ presentationId: deck, current: 1, total: 10, remaining: 9, canNavigate: true, timer: { text: '02:00', color: 'green' } }),
    () => { commands++ }, { load: async () => saved, save: async record => { saved = structuredClone(record) } })
  let status = await service.setEnabled(true)
  assert.equal(status.enabled, true)
  await service.configure(true, 'https://qa.cloudpub.ru')
  status = await service.createGrant('', ['deck-a'])
  assert(status.grants[0].name.trim().length > 0)
  assert.deepEqual(status.grants[0].presentations, ['deck-a'])
  const invite = await service.invitation(status.grants[0].id)
  const headers = { authorization: 'Bearer ' + new URLSearchParams(new URL(invite.url).hash.slice(1)).get('key'), 'x-clicker-client': 'qa-device-1234567890123', origin: 'https://qa.cloudpub.ru' }
  const target = status.target
  await fetch(target + '/state', { headers })
  status = await service.status()
  assert.equal(status.clients[0].blocked, true)
  await service.blockClient(status.clients[0].id, false)
  await wait(300)
  const post = id => fetch(target + '/command', { method: 'POST', headers, body: JSON.stringify({ id, direction: 'next' }) })
  assert.equal((await post('first')).status, 200)
  assert.equal(commands, 1)
  deck = 'deck-b'
  assert.notEqual((await post('wrong-deck')).status, 200)
  deck = 'deck-a'
  await service.setEnabled(false)
  assert.equal((await fetch(target)).status, 200)
  assert.equal((await post('paused')).status, 403)
  // Capture the real phone page, including disabled controls, in an isolated Chromium renderer.
  const phone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { offscreen: true } })
  await phone.loadURL(target + '/#key=' + new URLSearchParams(new URL(invite.url).hash.slice(1)).get('key'))
  await wait(500)
  assert.equal(await phone.webContents.executeJavaScript('connected'), true)
  assert.equal(await phone.webContents.executeJavaScript("document.getElementById('next').disabled"), true)
  const { writeFileSync } = require('node:fs')
  writeFileSync(join(artifacts, 'mobile-clicker-paused-qa.png'), (await phone.webContents.capturePage()).toPNG())
  phone.destroy()
  const guestHeaders = { origin: 'https://qa.cloudpub.ru', 'x-clicker-client': 'public-address-visitor-12345' }
  const joined = await fetch(target + '/join', { method: 'POST', headers: guestHeaders, body: JSON.stringify({ name: 'Public visitor' }) })
  assert.equal(joined.status, 200)
  const guestKey = (await joined.json()).key
  status = await service.status()
  const guest = status.clients.find(client => client.direct)
  assert(guest && guest.blocked)
  await service.approveClient(guest.id, ['deck-a'])
  const guestState = await fetch(target + '/state', { headers: { ...guestHeaders, authorization: 'Bearer ' + guestKey } })
  assert.equal((await guestState.json()).access, 'allowed')
  await service.disconnectClient(guest.id)
  assert.equal((await fetch(target + '/state', { headers: { ...guestHeaders, authorization: 'Bearer ' + guestKey } })).status, 401)
  let ticks = 0; let worstLag = 0; let last = performance.now()
  const ticker = setInterval(() => { const now = performance.now(); worstLag = Math.max(worstLag, now - last - 10); last = now; ticks++ }, 10)
  const begin = performance.now()
  const results = { accepted: 0, limited: 0, disconnected: 0 }
  await Promise.all(Array.from({ length: 24 }, async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(target + '/state', { headers })
        if (response.status === 429) results.limited++; else if (response.status === 200) results.accepted++
        await response.arrayBuffer()
      } catch { results.disconnected++ }
    }
  }))
  clearInterval(ticker)
  assert(results.limited > 0)
  assert(ticks > 0)
  assert.equal(commands, 1)
  console.log(JSON.stringify({ ok: true, requests: 2400, durationMs: Math.round(performance.now() - begin), mainTimerTicks: ticks, worstMainTimerLagMs: Math.round(worstLag), ...results }))
  await service.configure(false, 'https://qa.cloudpub.ru')
  assert.equal((await fetch(target)).status, 403)
}
if (process.versions.electron) {
  app.on('window-all-closed', () => {})
  setTimeout(() => { console.error('Mobile clicker QA timed out'); app.exit(1) }, 30000).unref()
  app.whenReady().then(run).then(async () => { await service?.dispose(); app.exit(0) }, async error => { console.error(error); await service?.dispose(); app.exit(1) })
} else {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  child.on('exit', code => process.exit(code ?? 1))
}
