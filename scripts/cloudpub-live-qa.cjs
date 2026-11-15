// Explicit live test: node scripts/cloudpub-live-qa.cjs --live
// Creates one temporary clicker publication and removes only that publication in finally.
if (!process.argv.includes('--live')) throw Error('Pass --live to test the installed, signed-in CLOUDPUB client')
const { join } = require('node:path')
const { buildSync } = require('esbuild')
const { mkdirSync, writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const root = join(__dirname, '..'); const artifacts = join(root, 'generated/mobile-clicker-qa')
mkdirSync(artifacts, { recursive: true })
for (const [name, source] of [['cloudpub', 'cloudpub'], ['core', 'mobile-clicker']]) {
  buildSync({ entryPoints: [join(root, 'src/main/' + source + '.ts')], outfile: join(artifacts, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs' })
}
const { CloudpubTunnel, findCloudpub, runCloudpub, cloudpubEndpoints, clickerComputerName } = require(join(artifacts, 'cloudpub.cjs'))
const { MobileClicker } = require(join(artifacts, 'core.cjs'))
let record; let server; let tunnel
async function run() {
  const executable = await findCloudpub()
  const before = cloudpubEndpoints(await runCloudpub(executable, ['ls']))
  server = new MobileClicker(() => ({ presentationId: 'test-deck', current: 1, total: 2, remaining: 1, canNavigate: true, timer: { text: '01:00', color: 'green' } }), () => { clicks++ }, () => ['127.0.0.1'], '127.0.0.1')
  let clicks = 0
  const status = await server.setEnabled(true)
  tunnel = new CloudpubTunnel({ load: async () => null, save: async value => { record = value; writeFileSync(join(artifacts, 'cloudpub-live-ownership.json'), JSON.stringify(value)) } }, undefined, undefined, () => clickerComputerName('isolated-live-qa-' + Date.now()))
  const remote = await tunnel.connect(status.target, async url => {
    await server.configure(true, url)
    const nonce = server.connectionProbe()
    const response = await fetch(url + '/.well-known/cuedeck-clicker/' + nonce, { signal: AbortSignal.timeout(10000), redirect: 'error' })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).nonce, nonce)
    server.clearProbe()
  })
  assert.equal((await fetch(remote + '/state', { signal: AbortSignal.timeout(10000) })).status, 401)
  const access = await server.createGrant('Live QA', ['test-deck'])
  const invitation = await server.invitation(access.grants[0].id)
  assert.equal(new URL(invitation.url).origin, remote)
  const headers = { authorization: 'Bearer ' + new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('key'), origin: remote, 'x-clicker-client': 'qa-live-client-1234567890' }
  const state = await fetch(remote + '/state', { headers, signal: AbortSignal.timeout(10000) })
  assert.equal(state.status, 200)
  assert.equal((await state.json()).enabled, false)
  server.blockClient(server.status().clients[0].id, false)
  const command = await fetch(remote + '/command', { method: 'POST', headers, body: JSON.stringify({ direction: 'next', id: 'live-qa' }), signal: AbortSignal.timeout(10000) })
  assert.equal(command.status, 200); assert.equal(clicks, 1)
  await server.setEnabled(false)
  const paused = await fetch(remote + '/command', { method: 'POST', headers, body: JSON.stringify({ direction: 'next', id: 'paused' }), signal: AbortSignal.timeout(10000) })
  assert.equal(paused.status, 403); assert.equal(clicks, 1)
  await tunnel.stop()
  const after = cloudpubEndpoints(await runCloudpub(executable, ['ls']))
  for (const endpoint of before) assert.equal(after.find(e => e.id === endpoint.id)?.status, endpoint.status)
  console.log('Live CLOUDPUB: registration, HTTPS handshake, scoped QR, admission, command, pause and isolation of other publications: OK')
}
run().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  try {
    await server?.configure(false, '')
    await tunnel?.stop()
    if (record) await runCloudpub(record.executable, ['unpublish', record.id], 10000)
  } catch (error) { console.error('Live QA cleanup did not complete:', error.message); process.exitCode = 1 }
  await server?.dispose()
})
