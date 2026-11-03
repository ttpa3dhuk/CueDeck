const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function fixture(t, valid = true, exitCode = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spout package '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'native/spout-sender/build'), { recursive: true })
  fs.copyFileSync(path.join(__dirname, '../scripts/verify-spout-package.cjs'), path.join(root, 'scripts/verify.cjs'))
  fs.writeFileSync(path.join(root, 'scripts/prepare-spout.cjs'), `require('fs').writeFileSync('verified.txt', process.argv.slice(2).join(' '));process.exit(${exitCode})`)
  fs.writeFileSync(path.join(root, 'native/spout-sender/build/build-manifest.json'), JSON.stringify({ sdk: {
    pin: '6b68a5b4fdeca6130b851e5f9366467a844860e5',
    treeSha256: valid ? '8b68ad1f27bcda0a3d0d64ec65b51f83bf4e39e07e98d2a8901c25cb66d04623' : 'unverified',
  } }))
  return { root, verify: require(path.join(root, 'scripts/verify.cjs')) }
}

test('Mac packaging does not require a Windows SDK', async () => {
  const verify = require('../scripts/verify-spout-package.cjs')
  await verify({ electronPlatformName: 'darwin', arch: 3 })
})

test('Windows ARM64 cannot receive an x64 native DLL', async () => {
  const verify = require('../scripts/verify-spout-package.cjs')
  await assert.rejects(verify({ electronPlatformName: 'win32', arch: 3 }), /requires Windows x64/)
})

test('an unverified SDK is rejected before the artifact preflight', async (t) => {
  const { root, verify } = fixture(t, false)
  await assert.rejects(verify({ electronPlatformName: 'win32', arch: 1 }), /verified official source/)
  assert.equal(fs.existsSync(path.join(root, 'verified.txt')), false)
})

test('Windows packaging runs artifact verification even when paths contain spaces', async (t) => {
  const { root, verify } = fixture(t)
  await verify({ electronPlatformName: 'win32', arch: 1 })
  assert.equal(fs.readFileSync(path.join(root, 'verified.txt'), 'utf8'), '--verify-only')
})

test('failed DLL verification prevents packaging', async (t) => {
  const { verify } = fixture(t, true, 7)
  await assert.rejects(verify({ electronPlatformName: 'win32', arch: 1 }))
})
