const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function verifyNativePackage(context) {
  if (context.electronPlatformName === 'win32') return require('./verify-spout-package.cjs')(context)
  if (context.electronPlatformName !== 'darwin') return
  const target = context.arch === 3 ? 'darwin-arm64' : context.arch === 1 ? 'darwin-x64' : null
  if (!target) throw new Error('Syphon packaging requires arm64 or x64')
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-syphon.cjs'), '--verify-only', '--target', target], {
    cwd: path.join(__dirname, '..'), stdio: 'inherit',
  })
}
