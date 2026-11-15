// One bounded QA run on Shuttle. No scheduler recurrence, product imports or installed-app writes.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const output = path.resolve(config.output), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const normal = p => path.resolve(p).replaceAll('\\', '/').toLowerCase()
if (!Number.isFinite(config.seconds) || config.seconds < 20 || config.seconds > 3600 || config.files?.length !== 2) throw Error('Invalid soak configuration')
fs.mkdirSync(output, { recursive: true })
const write = (name, data) => {
  const file = path.join(output, name), tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file)
}
const append = (name, data) => fs.appendFileSync(path.join(output, name), JSON.stringify(data) + '\n')
// Electron's wrapped fs treats app.asar as a directory. Hash the actual archive.
const rawFs = require('original-fs')
const sha = file => crypto.createHash('sha256').update(rawFs.readFileSync(file)).digest('hex')
const errors = [], connections = [], result = { pass: false, requestedSeconds: config.seconds, started: new Date().toISOString(), steps: 0, cases: [], samples: 0, errors }
let main, op, sampler, started = 0, fileIndex = 0, deckStep = 0, swapAt = 0, phase = 0, roles = [], appPid = null
const installedBefore = sha(config.installedAsar)
class CDP {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map()
    socket.addEventListener('message', event => {
      const m = JSON.parse(event.data)
      if (m.id) {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id); clearTimeout(p.timer)
        m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result)
      } else if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error')) {
        errors.push({ at: Date.now(), method: m.method, details: m.params }); append('errors.jsonl', errors.at(-1))
      }
    })
    socket.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('CDP connection closed')) } this.pending.clear() })
  }
  static async target(port, marker) {
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(10000) })).json()
    const found = pages.filter(p => p.url?.includes(marker) && p.webSocketDebuggerUrl)
    if (found.length !== 1) throw Error('Expected one ' + marker + ' target, found ' + found.length)
    const url = new URL(found[0].webSocketDebuggerUrl)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Non-loopback debugger')
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(Error('WebSocket connection timeout')) }, 10000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
    })
    const c = new CDP(socket); connections.push(c); await c.call('Runtime.enable'); return c
  }
  call(method, params = {}, timeout = 30000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(method + ' timeout')) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, timeout = 30000) {
    const data = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout)
    if (data.exceptionDetails) throw Error(JSON.stringify(data.exceptionDetails))
    return data.result?.value
  }
}
const api = expression => op.evaluate(expression, 120000)
async function observe(c, role) {
  await c.evaluate(`(async()=>{
    const s=await window.api.state.get();globalThis.__soak={state:s,last:null,next:null,count:0};
    window.api.state.onPatch(p=>Object.assign(__soak.state,p));
    window.api.state.onFull(s=>__soak.state=s);
    const old=CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData=function(...args){const r=old.apply(this,args);const id=this.canvas.id;
      if(['current-canvas','slide-canvas','next-canvas'].includes(id)){
        const b=this.canvas.getBoundingClientRect(),p=this.canvas.parentElement.getBoundingClientRect();
        const v={page:__soak.state.currentSlide,path:__soak.state.pdfPath,at:performance.timeOrigin+performance.now(),width:this.canvas.width,height:this.canvas.height,count:++__soak.count,rect:[b.x,b.y,b.width,b.height],parent:[p.x,p.y,p.width,p.height],window:[innerWidth,innerHeight]};
        if(id==='next-canvas')__soak.next=v;else __soak.last=v;
      }return r};return true})()`)
  return { c, role }
}
async function waitPaint(state, timeout = 30000) {
  return Promise.all(roles.map(async ({ c, role }) => ({ role, ...await c.evaluate(`(async()=>{
    const end=Date.now()+${timeout};while(!__soak.last||__soak.last.page!==${state.currentSlide}||__soak.last.path!==${JSON.stringify(state.pdfPath)}){
      if(Date.now()>end)throw Error('No matching product paint');await new Promise(r=>setTimeout(r,20))}
    return __soak.last})()`, timeout + 2000) })))
}
async function hashes() {
  return Promise.all(roles.map(async ({ c, role }) => ({ role, ...await c.evaluate(`(async()=>{
    const c=document.getElementById(${JSON.stringify(role === 'audience' ? 'slide-canvas' : 'current-canvas')});
    const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    return {width:c.width,height:c.height,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',a)),b=>b.toString(16).padStart(2,'0')).join('')}})()`) })))
}
async function checkFrames() {
  const rows = await hashes()
  if (!rows.every(x => x.width === rows[0].width && x.height === rows[0].height && x.hash === rows[0].hash)) throw Error('PGM pixels differ across real windows: ' + JSON.stringify(rows))
  append('quality.jsonl', { at: Date.now(), step: result.steps, rows }); result.samples++
}
async function front(role) {
  await main.evaluate(`(async()=>{const e=globalThis.__soakElectron,all=e.BrowserWindow.getAllWindows();
    for(const w of all){if(w.getTitle()==='CueDeck PDF frame owner')continue;if(w.webContents.getURL().includes('role=operator'))continue;w.setAlwaysOnTop(false)}
    const w=all.find(w=>w.webContents.getURL().includes(${JSON.stringify(role === 'audience' ? '/audience/index.html?role=audience' : 'role=speaker')}));
    w.setFullScreen(true);await new Promise(r=>setTimeout(r,250));w.setBounds(e.screen.getAllDisplays()[0].bounds);w.show();w.focus();return true})()`)
}
function memoryStatus() {
  const file = path.join(output, 'memory.jsonl')
  if (!fs.existsSync(file)) return
  const contents = fs.readFileSync(file, 'utf8'), end = contents.lastIndexOf('\n')
  if (end < 0) return // sampler may be writing its first row
  const lines = contents.slice(0, end).trim().split('\n')
  const row = JSON.parse(lines.at(-1))
  if (row.committed > row.limit * .9) throw Error('System commit exceeded 90%')
  result.latestMemory = row
}
async function swap() {
  const old = await api('window.api.state.get()'), before = await hashes()
  fileIndex = 1 - fileIndex
  const opened = await api('window.api.preview.openPath(' + JSON.stringify(config.files[fileIndex]) + ')')
  if (!opened?.ok) throw Error('Preview open failed: ' + JSON.stringify(opened))
  await sleep(250)
  const unchanged = await api('window.api.state.get()'), after = await hashes()
  if (unchanged.pdfPath !== old.pdfPath || unchanged.currentSlide !== old.currentSlide || JSON.stringify(before) !== JSON.stringify(after)) throw Error('Preview changed PGM')
  await api("window.api.preview.setSlideTakeMode('from-current')"); await api('window.api.preview.goto(1)')
  await api("window.api.preview.take('fade')")
  const state = await api('window.api.state.get()'); await waitPaint(state); await sleep(500); await checkFrames()
  await api('window.api.preview.clear()')
  deckStep = 0
  result.cases.push({ name: 'preview-take', at: Date.now(), fileIndex, slide: state.currentSlide })
}
async function run() {
  if (sha(config.payloadAsar) !== config.payloadSha256) throw Error('QA payload hash mismatch')
  main = await CDP.target(config.inspectorPort ?? 12182, 'file://')
  const identity = await main.evaluate("({exe:process.execPath,pid:process.pid,config:process.env.CUEDECK_PRODUCT_QA_CONFIG})")
  if (normal(identity.exe) !== normal(config.executable) || normal(identity.config) !== normal(config.appConfig)) throw Error('Unexpected application identity')
  appPid = identity.pid
  await main.evaluate("globalThis.__soakElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');globalThis.__soakGone=[];__soakElectron.app.on('web-contents-created',(_e,w)=>w.on('render-process-gone',(_e,d)=>__soakGone.push({id:w.id,...d})));for(const w of __soakElectron.webContents.getAllWebContents())w.on('render-process-gone',(_e,d)=>__soakGone.push({id:w.id,...d}));true")
  await main.evaluate("globalThis.__soakPowerBlocker=__soakElectron.powerSaveBlocker.start('prevent-display-sleep');true")
  op = await CDP.target(config.cdpPort ?? 12181, 'role=operator&')
  const displays = await api('window.api.displays.list()'), id = displays[0].id
  await api("window.api.layout.set('operator-speaker-audience'," + JSON.stringify({ operator: id, speaker: id, audience: id }) + ',true,false)')
  await sleep(800)
  for (const role of ['operator', 'speaker', 'audience']) {
    const c = role === 'operator' ? op : await CDP.target(config.cdpPort ?? 12181, 'role=' + role + '&')
    await c.call('Log.enable'); roles.push(await observe(c, role))
  }
  await api("(async()=>{await window.api.timer.setTickSound(false);await window.api.timer.setGongSound(false);await window.api.timer.setMode('countdown');await window.api.timer.setDuration(2700000);await window.api.timer.reset();await window.api.timer.start();return true})()")
  const opened = await api('window.api.pdf.openPath(' + JSON.stringify(config.files[0]) + ')')
  if (!opened?.ok) throw Error('Program open failed')
  let state = await api('window.api.state.get()'); await waitPaint(state); await front('audience'); await sleep(500); await checkFrames()
  const initial = await api('window.api.pdfFrames.stats()'); result.incarnation = initial.incarnation
  sampler = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'soak-memory.ps1'), '-Output', output, '-Executable', config.executable, '-ControllerPid', String(process.pid), '-Seconds', String(config.seconds + 120)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  sampler.stderr.on('data', data => append('sampler-errors.jsonl', { text: data.toString() }))
  started = Date.now(); swapAt = started + (config.swapSeconds ?? 300) * 1000
  write('status.json', { state: 'running', started, duration: config.seconds, controllerPid: process.pid, appPid, result })
  let nextSample = started, lastFront = started
  while (Date.now() - started < config.seconds * 1000) {
    const begin = Date.now()
    if (fs.existsSync(path.join(output, 'STOP'))) throw Error('Stop requested')
    memoryStatus()
    if (sampler.exitCode !== null) throw Error('Memory sampler exited before the run finished')
    if (Date.now() >= swapAt) { await swap(); swapAt = Date.now() + (config.swapSeconds ?? 300) * 1000 }
    state = await api('window.api.state.get()')
    // Full forward and reverse traversal, then deterministic jumps.
    const cycle = deckStep++ % (state.totalSlides * 2 + 20)
    let page = cycle < state.totalSlides ? cycle + 1 : cycle < state.totalSlides * 2 ? state.totalSlides * 2 - cycle : ((result.steps * 37) % state.totalSlides) + 1
    const noOp = state.currentSlide === page
    const at = Date.now(); await api('window.api.nav.goto(' + page + ')'); state = await api('window.api.state.get()')
    const painted = await waitPaint(state)
    const stats = await api('window.api.pdfFrames.stats()')
    if (stats.incarnation !== result.incarnation || stats.failure) throw Error('Unexpected PDF owner restart')
    if (stats.stats.residentBytes > 192 * 1024 * 1024 || stats.stats.inFlightBytes > 128 * 1024 * 1024) throw Error('Frame budget exceeded')
    const gone = await main.evaluate('__soakGone')
    if (gone.length) throw Error('Unexpected renderer loss: ' + JSON.stringify(gone))
    append('steps.jsonl', { step: result.steps, at, fileIndex, page, noOp, painted, stats })
    result.steps++
    if (result.steps % 10 === 0) await checkFrames()
    if (Date.now() - lastFront > (config.frontSeconds ?? 600) * 1000) { phase++; await front(phase % 2 ? 'speaker' : 'audience'); lastFront = Date.now() }
    if (Date.now() >= nextSample) {
      memoryStatus(); write('status.json', { state: 'running', elapsedSeconds: (Date.now() - started) / 1000, duration: config.seconds, controllerPid: process.pid, appPid, result })
      append('metrics.jsonl', { at: Date.now(), metrics: await main.evaluate('__soakElectron.app.getAppMetrics()') }); nextSample = Date.now() + 10000
    }
    if (errors.length) throw Error('Renderer console/runtime errors')
    await sleep(Math.max(0, (config.cadenceMs ?? 2000) - (Date.now() - begin)))
  }
  await checkFrames(); memoryStatus()
  if (!result.latestMemory?.processes?.some(p => p.Id === appPid)) throw Error('No memory samples for the owned GUI process')
  result.actualSeconds = (Date.now() - started) / 1000; result.pass = true
}
run().catch(error => { errors.push({ at: Date.now(), message: error.stack ?? String(error) }) }).finally(async () => {
  result.actualSeconds ??= started ? (Date.now() - started) / 1000 : 0
  try { if (op) await op.evaluate('window.api.timer.pause()', 5000) } catch {}
  // Use the product quit guard so PDF ports/owner and pending writes are closed.
  // Only answer the owned QA host's explicit three-button quit dialog.
  try {
    if (main) await main.evaluate(`(()=>{
      const e=__soakElectron,original=e.dialog.showMessageBox;
      e.dialog.showMessageBox=async function(...args){const options=args.at(-1);
        if(options?.message?.includes('CueDeck?')&&options.buttons?.length===3){
          e.dialog.showMessageBox=original;return {response:1,checkboxChecked:false}}
        return original.apply(this,args)};
      setTimeout(()=>e.app.quit(),100);return true})()`, 5000)
    // Node waits for the inspector to disconnect on normal exit. Release CDP
    // before waiting for the process, otherwise this check deadlocks itself.
    for (const c of connections) c.socket.close()
    if (appPid) {
      const deadline = Date.now() + 20000
      for (;;) {
        let alive = true
        try { process.kill(appPid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
        if (!alive) { result.guiExited = true; break }
        if (Date.now() > deadline) throw Error('Owned GUI did not finish its normal quit path')
        await sleep(200)
      }
    }
  } catch (error) { errors.push({ at: Date.now(), message: 'QA shutdown: ' + String(error) }) }
  fs.writeFileSync(path.join(output, 'sampler-stop.flag'), 'done')
  for (const c of connections) c.socket.close()
  if (sampler) { await sleep(1500); if (sampler.exitCode === null) sampler.kill() }
  result.installedAsarUnchanged = sha(config.installedAsar) === installedBefore
  if (!result.installedAsarUnchanged || errors.length) result.pass = false
  result.finished = new Date().toISOString()
  write('result.json', result); write('status.json', { state: result.pass ? 'passed' : 'failed', result })
  process.exitCode = result.pass ? 0 : 1
}).catch(error => { console.error(error); process.exitCode = 1 })
