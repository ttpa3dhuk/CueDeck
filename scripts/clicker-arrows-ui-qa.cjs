// Isolated application UI smoke test. Run: node scripts/mobile-clicker-ui-qa.cjs
const electron = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const root = join(__dirname, '..')
const artifacts = join(root, 'generated/mobile-clicker-qa')
const live = process.argv.includes('--live')
if (!process.versions.electron) {
  const env = { ...process.env, CUEDECK_NO_NAG: '1' }; delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(electron, [__filename, ...(live ? ['--live'] : [])], { env, stdio: 'inherit', windowsHide: true })
  child.on('exit', code => process.exit(code ?? 1))
} else {
  const { app, BrowserWindow } = electron
  require('node:fs').mkdirSync(artifacts, { recursive: true })
  const assert = require('node:assert/strict')
  const data = mkdtempSync(join(require('node:os').tmpdir(), 'cuedeck-clicker-ui-'))
  process.env.CUEDECK_QA_MACHINE_ID = 'isolated-ui-qa-' + data
  app.setPath('userData', data)
  writeFileSync(join(data, 'cue-deck.json'), JSON.stringify({ uiLang: 'ru', askLayoutOnStartup: false, uiTheme: 'dark', cleanExit: true }))
  process.env.CUEDECK_NO_NAG = '1'
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  let operator; let generalPhone
  async function cleanupLive() {
    if (!live) return
    if (generalPhone && !generalPhone.isDestroyed()) generalPhone.destroy()
    try {
      if (operator && !operator.isDestroyed()) await operator.webContents.executeJavaScript("window.api.mobileClicker.configure(false,'')")
      const file = join(data, 'cloudpub-clicker.json')
      if (require('node:fs').existsSync(file)) {
        const owned = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
        const cliModule = join(artifacts, 'cloudpub-ui-cleanup.cjs')
        require('esbuild').buildSync({ entryPoints: [join(root, 'src/main/cloudpub.ts')], outfile: cliModule, bundle: true, platform: 'node', format: 'cjs' })
        await require(cliModule).runCloudpub(owned.executable, ['unpublish', owned.id], 10000)
      }
    } catch (error) { console.error('UI live cleanup failed:', error.message); throw error }
  }
  setTimeout(() => { console.error('UI QA timeout'); void cleanupLive().finally(() => app.exit(1)) }, live ? 90000 : 30000).unref()
  import(require('node:url').pathToFileURL(join(root, 'out/main/index.js')).href).then(async () => {
    let window
    for (let i = 0; i < 100; i++) {
      window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('presenter/index.html') && win.webContents.getURL().includes('role=operator'))
      if (window && !window.webContents.isLoading()) break
      await wait(100)
    }
    assert(window, 'Operator window missing')
    operator = window
    await wait(500)
    const geometry = []
    for (const width of [960, 1200, 1600]) {
      window.setBounds({ x: 30, y: 30, width, height: 850 }); await wait(250)
      const row = await window.webContents.executeJavaScript(`(()=>{
        const box = s => {const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,w:r.width,right:r.right}};
        return {bar:box('.bottombar'),nav:box('#program-nav'),left:box('.bottombar-left'),right:box('.bottombar-right')}
      })()`)
      assert(Math.abs(row.nav.x+row.nav.w/2-row.bar.x-row.bar.w/2)<1, JSON.stringify(row))
      assert(row.left.right<=row.nav.x && row.nav.right<=row.right.x,JSON.stringify(row))
      geometry.push({width,...row})
    }
    await window.webContents.executeJavaScript(`(async()=>{
      await window.api.clicker.setGlobal(false);
      await window.api.clicker.setGlobalArrows(true);
      const select=document.getElementById('clicker-arrow-axis');
      select.value='vertical';select.dispatchEvent(new Event('change'));
    })()`)
    await wait(200)
    assert.equal(await window.webContents.executeJavaScript('window.api.state.get().then(s=>s.clickerArrowAxis)'), 'vertical')
    const settingsJson=JSON.parse(require('node:fs').readFileSync(join(data,'cue-deck.json'),'utf8'))
    assert.equal(settingsJson.clickerArrowAxis, 'vertical')
    await window.webContents.executeJavaScript('window.api.clicker.setGlobal(true)')
    const focusWindow=new BrowserWindow({show:true,width:200,height:100});focusWindow.focus();await wait(350)
    assert(electron.globalShortcut.isRegistered('Down'));assert(electron.globalShortcut.isRegistered('Up'))
    assert(!electron.globalShortcut.isRegistered('Left'));assert(!electron.globalShortcut.isRegistered('Right'))
    await window.webContents.executeJavaScript("window.api.clicker.setArrowAxis('horizontal')");await wait(150)
    assert(electron.globalShortcut.isRegistered('Right'));assert(electron.globalShortcut.isRegistered('Left'))
    assert(!electron.globalShortcut.isRegistered('Down'));assert(!electron.globalShortcut.isRegistered('Up'))
    focusWindow.destroy();window.focus();await wait(150)
    assert(!electron.globalShortcut.isRegistered('Right'));assert(!electron.globalShortcut.isRegistered('Left'))
    await window.webContents.executeJavaScript('window.api.clicker.setGlobal(false)')
    writeFileSync(join(artifacts,'arrow-and-footer-qa.json'),JSON.stringify({pass:true,geometry,axisSaved:true,globalPairsVerified:true},null,2))
    console.log('Arrow selector persistence, actual global pair registration, focus release, footer center and non-overlap: PASS')

    await window.webContents.executeJavaScript("document.getElementById('settings-btn').click(); document.querySelector('button[data-section=clicker]').click()")
    await wait(250)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('online-clicker-settings').open"), false)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('clicker-global-toggle').getBoundingClientRect().height>0"), true)
    await window.webContents.executeJavaScript("document.getElementById('global-clicker-toggle').click()")
    await wait(250)
    const globalState = await window.webContents.executeJavaScript('window.api.state.get()')
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('global-clicker-toggle').getAttribute('aria-pressed')"), String(globalState.clickerGlobal))
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('clicker-global-toggle').checked"), globalState.clickerGlobal)
    await window.webContents.executeJavaScript('window.api.clicker.setGlobal(false)')
    await wait(100)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('global-clicker-toggle').getAttribute('aria-pressed')"), 'false')
    const originalRegister = electron.globalShortcut.register
    electron.globalShortcut.register = () => false
    try {
      await window.webContents.executeJavaScript("document.getElementById('global-clicker-toggle').click()")
      await wait(200)
      assert.equal(await window.webContents.executeJavaScript("document.getElementById('global-clicker-toggle').classList.contains('global-clicker-error')"), true)
      writeFileSync(join(artifacts, 'global-clicker-error-qa.png'), (await window.webContents.capturePage()).toPNG())
    } finally { electron.globalShortcut.register = originalRegister }
    await window.webContents.executeJavaScript("document.getElementById('clicker-global-toggle').checked=false; document.getElementById('clicker-global-toggle').dispatchEvent(new Event('change'))")
    await wait(100)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('global-clicker-toggle').classList.contains('global-clicker-error')"), false)
    writeFileSync(join(artifacts, 'mobile-clicker-settings-collapsed-qa.png'), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.getElementById('online-clicker-settings').open=true")
    await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-enabled').click()")
    await wait(750)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-enabled').checked"), true)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-target').textContent.includes('127.0.0.1')"), true)
    if (live) {
      await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-cloud-auto').click()")
      let connected = false
      for (let i = 0; i < 200; i++) {
        const status = await window.webContents.executeJavaScript('window.api.mobileClicker.status()')
        if (status.cloudpub?.state === 'connected') { connected = true; break }
        if (status.cloudpub?.state === 'error') throw Error(status.cloudpub.message)
        await wait(250)
      }
      assert(connected, 'Automatic CLOUDPUB setup did not complete')
      assert.match(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-general').value"), /^https:\/\/cuedeck-[a-f0-9]{10}\.cloudpub\.ru$/)
    } else {
      await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-public').value='https://qa.cloudpub.ru'; document.getElementById('mobile-clicker-online').checked=true; document.getElementById('mobile-clicker-cloud-save').click()")
    }
    await wait(300)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-details').classList.contains('hidden')"), true)
    writeFileSync(join(artifacts, 'mobile-clicker-settings-qa.png'), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-name').value='QA Speaker'; document.getElementById('mobile-clicker-create').click()")
    await wait(500)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-invite').classList.contains('hidden')"), false)
    if (live) {
      // Test the JavaScript page through CLOUDPUB, not only raw HTTP requests from Node.
      const invitation = await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-invite-url').value")
      generalPhone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { offscreen: true } })
      await generalPhone.loadURL(new URL(invitation).origin)
      assert.equal(await generalPhone.webContents.executeJavaScript("document.getElementById('join').hidden"), false)
      await generalPhone.webContents.executeJavaScript("document.getElementById('join-name').value='General URL visitor'; document.getElementById('join-submit').click()")
      let visitor
      for (let i = 0; i < 40; i++) {
        const status = await window.webContents.executeJavaScript('window.api.mobileClicker.status()')
        visitor = status.clients?.find(client => client.direct && client.name === 'General URL visitor')
        if (visitor) break
        await wait(250)
      }
      assert(visitor, 'General public address did not create a pending request')
      assert.equal(visitor.blocked, true)
      await wait(1200)
      await window.webContents.executeJavaScript("(() => { const row = Array.from(document.querySelectorAll('.clicker-request')).find(r => r.dataset.clientId === " + JSON.stringify(visitor.id) + "); if (!row) throw Error('Missing bottom guest request'); const select = row.querySelector('select'); select.value='*'; select.dispatchEvent(new Event('change')); row.querySelector('.clicker-request-approve').click(); })()")
      let admitted = false
      for (let i = 0; i < 40; i++) {
        admitted = await generalPhone.webContents.executeJavaScript("connected && allowed===false && document.getElementById('join').hidden && document.getElementById('timer').textContent!=='--:--'")
        if (admitted) break
        await wait(250)
      }
      assert(admitted, 'General public browser did not receive approved state')
      console.log('General public CLOUDPUB address: join request and operator admission: OK')
      const phone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { offscreen: true } })
      await phone.loadURL(invitation)
      let connected = false
      for (let i = 0; i < 24; i++) {
        const view = await phone.webContents.executeJavaScript("({status:document.getElementById('status')?.textContent, connected:typeof connected!=='undefined'&&connected})")
        if (view.connected) { connected = true; console.log('Public phone browser:', view.status); break }
        if (i === 23) console.error('Public phone browser failed:', view.status)
        await wait(250)
      }
      assert(connected, 'The public browser page could not fetch clicker state')
      await wait(1200)
      const rejectedId = await window.webContents.executeJavaScript("(() => { const row = Array.from(document.querySelectorAll('.clicker-request')).find(r => !r.querySelector('select')); if (!row) throw Error('Missing invitation request'); const id = row.dataset.clientId; row.querySelector('.clicker-request-reject').click(); return id; })()")
      await wait(1300)
      const rejected = (await window.webContents.executeJavaScript('window.api.mobileClicker.status()')).clients.find(c => c.id === rejectedId)
      assert.equal(rejected.blocked, true)
      assert.equal(rejected.pending, false)
      assert.equal(await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('.clicker-request')).some(r => r.dataset.clientId === " + JSON.stringify(rejectedId) + ")"), false)
      phone.destroy()
    }
    // Add real PDFs while settings remain open: the scope picker must refresh without reopening it.
    function blankPdf() {
      const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']
      let pdf = '%PDF-1.4\n'; const offsets = [0]
      objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
      const xref = Buffer.byteLength(pdf)
      pdf += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
      return pdf + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    }
    const paths = [join(data, 'scope-a.pdf'), join(data, 'scope-b.pdf')]
    paths.forEach(file => writeFileSync(file, blankPdf()))
    const entries = await window.webContents.executeJavaScript('window.api.playlist.addPaths(' + JSON.stringify(paths) + ')')
    await wait(300)
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('#mobile-clicker-presentations input').length"), 2)
    await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-all').click(); document.getElementById('mobile-clicker-name').value=''; document.querySelector('#mobile-clicker-presentations input').checked=true; document.getElementById('mobile-clicker-create').click()")
    await wait(500)
    const scoped = await window.webContents.executeJavaScript('window.api.mobileClicker.status()')
    assert.equal(scoped.grants.length, 2)
    assert.deepEqual(scoped.grants[1].presentations, [entries[0].id])
    assert(scoped.grants[1].name.trim().length > 0)
    if (live) {
      const scopedPhone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { offscreen: true } })
      await scopedPhone.loadURL(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-invite-url').value"))
      let client
      for (let i = 0; i < 40; i++) {
        client = (await window.webContents.executeJavaScript('window.api.mobileClicker.status()')).clients.find(c => c.grantId === scoped.grants[1].id)
        if (client) break
        await wait(250)
      }
      assert(client)
      await wait(1200)
      const requestText = await window.webContents.executeJavaScript("(() => { const row = Array.from(document.querySelectorAll('.clicker-request')).find(r => r.dataset.clientId === " + JSON.stringify(client.id) + "); if (!row || row.querySelector('select')) throw Error('Missing scoped bottom request'); const text = row.textContent; row.querySelector('.clicker-request-approve').click(); return text; })()")
      assert(requestText.includes('scope-a'), 'Bottom request did not show the requested presentation')
      await wait(300)
      const accepted = (await window.webContents.executeJavaScript('window.api.mobileClicker.status()')).clients.find(c => c.id === client.id)
      assert.equal(accepted.pending, false)
      assert.equal(accepted.blocked, false)
      assert.deepEqual((await window.webContents.executeJavaScript('window.api.mobileClicker.status()')).grants[1].presentations, [entries[0].id])
      let message = false
      for (let i = 0; i < 40; i++) {
        message = await scopedPhone.webContents.executeJavaScript("document.getElementById('slides').textContent==='Ваша презентация не открыта'")
        if (message) break
        await wait(250)
      }
      assert(message, 'The scoped phone did not explain that its presentation is not open')
      scopedPhone.destroy()
    }
    await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-guest-open').checked=true; document.getElementById('mobile-clicker-all').checked=true; document.getElementById('mobile-clicker-guest-apply').click()")
    await wait(200)
    assert.equal((await window.webContents.executeJavaScript('window.api.mobileClicker.status()')).guestOpen, true)
    if (live) {
      const guest = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { offscreen: true } })
      await guest.loadURL(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-general').value"))
      let ready = false
      for (let i = 0; i < 40; i++) {
        ready = await guest.webContents.executeJavaScript("typeof connected!=='undefined'&&connected&&document.getElementById('join').hidden&&document.getElementById('timer').textContent!=='--:--'")
        if (ready) break
        await wait(250)
      }
      assert(ready, 'Open guest mode required manual approval')
      guest.destroy()
    }
    await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-guest-open').checked=false; document.getElementById('mobile-clicker-guest-apply').click()")
    await wait(200)
    await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-all').checked=false")
    await window.webContents.executeJavaScript("document.querySelector('#mobile-clicker-presentations input').checked=false; document.getElementById('mobile-clicker-create').click()")
    await wait(100)
    assert.equal((await window.webContents.executeJavaScript('window.api.mobileClicker.status()')).grants.length, 2)
    await window.webContents.executeJavaScript("document.getElementById('settings-close').click(); document.getElementById('mobile-clicker-pause').click()")
    await wait(300)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('mobile-clicker-pause').getAttribute('aria-pressed')"), 'true')
    console.log('Mobile clicker settings, QR, scoped presentation with blank name, live playlist refresh, empty selection and bottom pause UI: OK')
    await cleanupLive()
    app.exit(0)
  }).catch(async error => { console.error(error); await cleanupLive().catch(() => undefined); app.exit(1) })
}
