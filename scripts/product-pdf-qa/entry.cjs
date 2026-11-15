// Distinct QA host running the real product entry, never the user's dev launcher.
// Own application data is required for concurrent QA; it is not a settings backup.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const config = JSON.parse(fs.readFileSync(process.env.CUEDECK_PRODUCT_QA_CONFIG, 'utf8'))
const root = path.resolve(config.output)
fs.mkdirSync(root, { recursive: true })
const data = path.join(root, 'qa-application-data')
fs.mkdirSync(data, { recursive: true })
app.setName('CueDeck Product PDF QA')
app.setPath('userData', data)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', String(config.cdpPort ?? 12181))
require('node:inspector').open(config.inspectorPort ?? 12182, '127.0.0.1')
process.on('SIGTERM', () => app.exit(0))
const stop = setInterval(() => { if (fs.existsSync(path.join(root, 'stop.flag'))) app.exit(0) }, 250)
stop.unref()
const settings = path.join(data, 'cue-deck.json')
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ uiLang: 'ru', askLayoutOnStartup: false,
  startup: { mode: 'empty', autoTestScreen: false, autosaveMinutes: 0 },
  remote: { enabled: false, httpPort: config.httpPort ?? 12184, oscPort: config.oscPort ?? 12185,
    httpToken: 'qa-local-only', oscHost: '127.0.0.1', logCommands: true },
  outputMonitorsEnabled: false }))
process.env.CUEDECK_NO_NAG = '1'
if (config.tile === false) delete process.env.PRESENTER_DEV_TILE
else process.env.PRESENTER_DEV_TILE = '1'
process.env.CUEDECK_SHARED_PDF = config.mode === 'legacy' ? '0' : '1'
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
void import(pathToFileURL(path.join(__dirname, 'out/main/index.js')).href).catch(error => {
  fs.writeFileSync(path.join(root, 'startup-error.txt'), String(error.stack ?? error)); app.exit(1)
})
