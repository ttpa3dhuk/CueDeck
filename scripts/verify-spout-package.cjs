const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

module.exports = async function verifySpoutPackage(context) {
  if (context.electronPlatformName !== 'win32') return
  // electron-builder Arch.x64 is 1. Other Windows architectures have no native
  // sender build yet; do not package an x64 DLL into an incompatible runtime.
  if (context.arch !== 1) throw new Error('Spout packaging currently requires Windows x64')
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../native/spout-sender/build/build-manifest.json'), 'utf8'))
  // Independently checked against the official commit archive on 2026-11-02.
  // A matching directory name alone does not establish SDK provenance.
  if (manifest.sdk?.pin !== '6b68a5b4fdeca6130b851e5f9366467a844860e5' ||
      manifest.sdk?.treeSha256 !== '8b68ad1f27bcda0a3d0d64ec65b51f83bf4e39e07e98d2a8901c25cb66d04623') {
    throw new Error('Spout SDK does not match the verified official source')
  }
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-spout.cjs'), '--verify-only'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  })
}
