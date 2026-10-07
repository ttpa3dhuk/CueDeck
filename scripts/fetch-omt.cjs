/**
 * Скачивает библиотеку Open Media Transport (libomt + кодек libvmx) в vendor/omt/.
 * В git бинарники не лежат (~25 МБ): берём официальный релиз с GitHub и сверяем
 * sha256. Запускается сам перед `npm run dev` и сборкой; уже скачанное не трогает.
 *
 *   vendor/omt/mac/  libomt.dylib, libvmx.dylib (universal: arm64 + x86_64)
 *   vendor/omt/win/  libomt.dll, libvmx.dll (x64)
 */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const VERSION = '1.0.0.19'
const URL = `https://github.com/openmediatransport/libomtnet/releases/download/v${VERSION}/OpenMediaTransport.Binaries.Release.v${VERSION}.zip`
const SHA256 = 'c62460174499dabe703e3e57372daf5f1dd95f890355d11e30052b9ed35bdac4'

const ROOT = path.join(__dirname, '..', 'vendor', 'omt')
const FILES = {
  mac: ['Libraries/MacOS/libomt.dylib', 'Libraries/MacOS/libvmx.dylib'],
  win: ['Libraries/Winx64/libomt.dll', 'Libraries/Winx64/libvmx.dll'],
}
const STAMP = path.join(ROOT, 'VERSION')

function ready() {
  if (!fs.existsSync(STAMP) || fs.readFileSync(STAMP, 'utf8').trim() !== VERSION) return false
  return Object.entries(FILES).every(([dir, list]) =>
    list.every((f) => fs.existsSync(path.join(ROOT, dir, path.basename(f)))),
  )
}

function main() {
  if (ready()) return
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuedeck-omt-'))
  const zip = path.join(tmp, 'omt.zip')
  // Своей копии zip рядом (generated/omt-spike) хватает, чтобы не качать заново.
  const local = path.join(__dirname, '..', 'generated', 'omt-spike', path.basename(URL))
  if (fs.existsSync(local)) fs.copyFileSync(local, zip)
  else {
    console.log(`OMT ${VERSION}: качаю ${URL}`)
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', zip, URL], { stdio: 'inherit' })
  }
  const sum = createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
  if (sum !== SHA256) throw new Error(`OMT: sha256 не совпал (${sum}), файл не тот`)
  const out = path.join(tmp, 'x')
  fs.mkdirSync(out)
  // unzip есть на маке; на Windows-машине разработчика — tar из комплекта Windows 10+.
  const list = [...FILES.mac, ...FILES.win, 'LICENSE.txt']
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', out, ...list])
  else execFileSync('unzip', ['-q', '-o', zip, ...list, '-d', out])
  fs.rmSync(ROOT, { recursive: true, force: true })
  for (const [dir, files] of Object.entries(FILES)) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true })
    for (const f of files) fs.copyFileSync(path.join(out, f), path.join(ROOT, dir, path.basename(f)))
    fs.copyFileSync(path.join(out, 'LICENSE.txt'), path.join(ROOT, dir, 'OMT-LICENSE.txt'))
  }
  fs.writeFileSync(STAMP, VERSION + '\n')
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`OMT ${VERSION}: готово → vendor/omt/`)
}

try {
  main()
} catch (err) {
  // Без OMT программа работает — выходы OMT просто покажут «библиотека не найдена».
  console.warn(`⚠ OMT не скачан: ${err.message}`)
  if (process.argv.includes('--strict')) process.exit(1)
}
