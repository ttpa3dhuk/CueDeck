// Explicit live regression for the application's actual quit guard.
if (!process.argv.includes('--live')) throw Error('Pass --live')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.join(__dirname, '..'), artifacts = path.join(root, 'generated/mobile-clicker-qa')
const ownership = path.join(artifacts, 'quit-live-ownership.json')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(artifacts, { recursive: true })
if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const { buildSync } = require('esbuild')
  const modulePath = path.join(artifacts, 'quit-cloudpub.cjs')
  buildSync({ entryPoints: [path.join(root, 'src/main/cloudpub.ts')], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs' })
  const { findCloudpub, runCloudpub, cloudpubEndpoints } = require(modulePath)
  ;(async () => {
    fs.rmSync(ownership, { force: true })
    const executable = await findCloudpub()
    const before = cloudpubEndpoints(await runCloudpub(executable, ['ls']))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [__filename, '--live'], { env, stdio: 'inherit' })
    let exited = false, watchdog
    const exit = new Promise(resolve => {
      child.once('exit', code => { exited = true; clearTimeout(watchdog); resolve(code) })
      watchdog = setTimeout(() => { child.kill(); }, 75000)
    })
    let record
    try {
      const code = await exit
      assert.equal(code, 0, 'Application quit failed')
      record = JSON.parse(fs.readFileSync(ownership, 'utf8'))
      assert(!before.some(e => e.id === record.id), 'Must own a new test publication')
      const after = cloudpubEndpoints(await runCloudpub(executable, ['ls']))
      const own = after.find(e => e.id === record.id)
      assert(own && own.target === record.target && own.status === 'offline', 'Quit did not stop the exact publication')
      for (const e of before) assert.equal(after.find(a => a.id === e.id)?.status, e.status)
      console.log('Actual app.quit -> quit guard -> CLOUDPUB offline: PASS')
    } finally {
      if (!exited) child.kill()
      if (!record && fs.existsSync(ownership)) record = JSON.parse(fs.readFileSync(ownership, 'utf8'))
      if (record && !before.some(e => e.id === record.id)) {
        const own = cloudpubEndpoints(await runCloudpub(executable, ['ls'])).find(e => e.id === record.id)
        if (own) {
          assert.equal(own.target, record.target)
          if (own.status !== 'offline') await runCloudpub(executable, ['stop', record.id])
          await runCloudpub(executable, ['unpublish', record.id])
        }
        assert(!cloudpubEndpoints(await runCloudpub(executable, ['ls'])).some(e => e.id === record.id))
        console.log('Owned quit-test publication removed: PASS')
      }
    }
  })().catch(e => { console.error(e.message); process.exitCode = 1 })
} else {
  const { app, BrowserWindow, dialog } = require('electron')
  const data = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cuedeck-quit-live-'))
  app.setPath('userData', data)
  process.env.CUEDECK_NO_NAG = '1'
  process.env.CUEDECK_QA_MACHINE_ID = 'quit-live-' + data
  fs.writeFileSync(path.join(data, 'cue-deck.json'), JSON.stringify({ uiLang: 'en', askLayoutOnStartup: false, cleanExit: true }))
  const originalDialog = dialog.showMessageBox
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1)
    if (options.message === 'Close CueDeck?' && options.buttons?.length === 3) return { response: 1 }
    return originalDialog(...args)
  }
  import(require('node:url').pathToFileURL(path.join(root, 'out/main/index.js')).href).then(async () => {
    let op
    for (let i = 0; i < 100; i++) {
      op = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('role=operator'))
      if (op && !op.webContents.isLoading()) break
      await wait(100)
    }
    assert(op)
    await op.webContents.executeJavaScript('window.api.mobileClicker.setEnabled(true)')
    const result = await op.webContents.executeJavaScript('window.api.mobileClicker.connectCloudpub()')
    const file = path.join(data, 'cloudpub-clicker.json')
    if (fs.existsSync(file)) fs.copyFileSync(file, ownership)
    assert.equal(result.cloudpub?.state, 'connected')
    app.quit()
  }).catch(error => {
    const file = path.join(data, 'cloudpub-clicker.json')
    if (fs.existsSync(file)) fs.copyFileSync(file, ownership)
    console.error(error.message); app.exit(1)
  })
}
