// Real PPTX conversion, UI counters, label entry and TAKE. One QA app at a time.
const electron = require('electron')
const { join } = require('node:path')
const fs = require('node:fs')
const root = join(__dirname, '..')
const artifacts = join(root, 'generated/slide-numbering-qa')
if (!process.versions.electron) {
  const env = { ...process.env, CUEDECK_NO_NAG: '1' }; delete env.ELECTRON_RUN_AS_NODE
  require('node:child_process').spawn(electron, [__filename], { env, stdio: 'inherit' })
    .on('exit', code => process.exit(code ?? 1))
} else {
  const { app, BrowserWindow } = electron
  const assert = require('node:assert/strict')
  const data = fs.mkdtempSync(join(require('node:os').tmpdir(), 'cuedeck-numbering-qa-'))
  app.setPath('userData', data)
  fs.writeFileSync(join(data, 'cue-deck.json'), JSON.stringify({ uiLang: 'ru', askLayoutOnStartup: false, cleanExit: true, outputMonitorsEnabled: false }))
  process.env.CUEDECK_NO_NAG = '1'
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  setTimeout(() => { console.error('numbering QA timeout'); app.exit(1) }, 90000).unref()
  import(require('node:url').pathToFileURL(join(root, 'out/main/index.js')).href).then(async () => {
    let operator
    for (let i = 0; i < 100; i++) {
      operator = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('role=operator'))
      if (operator && !operator.webContents.isLoading()) break
      await wait(100)
    }
    assert(operator)
    const run = code => operator.webContents.executeJavaScript(code)
    await wait(400)
    const result = await run(`window.api.preview.openPath(${JSON.stringify(join(artifacts,'three-slides.pptx'))})`)
    assert.equal(result.ok,true,JSON.stringify(result))
    await wait(500)
    let state = await run('window.api.state.get()')
    assert.equal(state.preview.totalSlides,5)
    assert.deepEqual(state.preview.slideNumbering,{total:3,pages:['1','2','3','3.1','3.2']})
    async function goto(label, page) {
      await run(`(()=>{ const e=document.getElementById('preview-goto-input');e.value=${JSON.stringify(label)};e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`)
      await wait(200)
      assert.equal((await run('window.api.state.get()')).preview.currentSlide,page)
      const labelText=await run("document.getElementById('preview-counter').textContent")
      assert.equal(labelText,`${label} / 3`)
    }
    await goto('3.2',5)
    await goto('3',3)
    await run('window.api.preview.next()');await wait(150)
    assert.equal(await run("document.getElementById('preview-counter').textContent"),'3.1 / 3')
    await run("window.api.preview.setSlideTakeMode('from-current')")
    await run('window.api.preview.take()');await wait(500)
    state=await run('window.api.state.get()')
    assert.equal(state.currentSlide,4)
    assert.deepEqual(state.slideNumbering,{total:3,pages:['1','2','3','3.1','3.2']})
    assert.equal(await run("document.getElementById('program-nav-current').textContent"),'3.1 / 3')
    fs.writeFileSync(join(artifacts,'operator.png'),(await operator.webContents.capturePage()).toPNG())
    // Reopen the same deck to exercise the prepared cache, then TAKE clears old mapping for PDF.
    await run(`window.api.preview.openPath(${JSON.stringify(join(artifacts,'three-slides.pptx'))})`)
    assert.deepEqual((await run('window.api.state.get()')).preview.slideNumbering,state.slideNumbering)
    const pdf = fs.readdirSync(data,{recursive:true}).find(name=>name.endsWith('.pdf'))
    assert(pdf)
    await run(`window.api.preview.openPath(${JSON.stringify(join(data,pdf))})`)
    await run('window.api.preview.take()');await wait(200)
    assert.equal((await run('window.api.state.get()')).slideNumbering,undefined)
    assert.equal(await run("document.getElementById('program-nav-current').textContent"),'1 / 5')
    fs.writeFileSync(join(artifacts,'result.json'),JSON.stringify({ok:true,renderPages:5,sourceSlides:3,labels:state.slideNumbering.pages,goto:true,take:true,cache:true},null,2))
    console.log('SLIDE NUMBERING UI PASS')
    app.exit(0)
  }).catch(error=>{console.error(error);app.exit(1)})
}
