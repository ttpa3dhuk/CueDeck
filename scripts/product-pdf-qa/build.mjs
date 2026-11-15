import { cp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions } from '@electron/asar'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, 'generated/product-pdf-qa')
const target = join(output, 'app')
await mkdir(target, { recursive: true })
await rm(join(target, 'out'), { recursive: true, force: true })
await cp(join(root, 'out'), join(target, 'out'), { recursive: true, force: true })
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'cuedeck-product-pdf-qa',
  type: 'module', version: pkg.version, main: 'qa-entry.cjs' }, null, 2))
await cp(join(root, 'scripts/product-pdf-qa/entry.cjs'), join(target, 'qa-entry.cjs'))
const koffi = join(target, 'node_modules/koffi')
await mkdir(koffi, { recursive: true })
for (const name of ['index.js', 'package.json', 'LICENSE.txt', 'lib']) {
  const source = join(root, 'node_modules/koffi', name)
  if (await access(source).then(() => true, () => false)) await cp(source, join(koffi, name), { recursive: true, force: true })
}
for (const arch of ['darwin_arm64', 'darwin_x64', 'win32_x64']) {
  const targetDir = join(koffi, 'build/koffi', arch)
  await mkdir(targetDir, { recursive: true })
  await cp(join(root, 'node_modules/koffi/build/koffi', arch, 'koffi.node'), join(targetDir, 'koffi.node'))
}
if (process.platform === 'darwin') {
  const resources = '/Applications/CueDeck.app/Contents/Resources'
  for (const [source, destination] of [['omt', 'vendor/omt/mac'], ['syphon', 'native/syphon-probe/build'], ['ffprobe', 'vendor/ffprobe/darwin-arm64']]) {
    if (await access(join(resources, source)).then(() => true, () => false)) {
      await mkdir(dirname(join(target, destination)), { recursive: true })
      await cp(join(resources, source), join(target, destination), { recursive: true, force: true, verbatimSymlinks: true })
    }
  }
}
await rm(join(output, 'app.asar.unpacked'), { recursive: true, force: true })
await createPackageWithOptions(target, join(output, 'app.asar'), { unpack: '**/*.node' })
console.log(target)
