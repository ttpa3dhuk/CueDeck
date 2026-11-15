import { build as bundle } from 'esbuild'
import { build } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(root, 'generated/render-core-qa/app')
await mkdir(output, { recursive: true })
await bundle({ entryPoints: [resolve(root, 'scripts/render-core-qa/main.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], outfile: resolve(output, 'main.cjs') })
await bundle({ entryPoints: [resolve(root, 'scripts/render-core-qa/preload.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], outfile: resolve(output, 'preload.cjs') })
await build({ configFile: false, root: resolve(root, 'scripts/render-core-qa/renderer'),
  base: './', build: { target: 'esnext', outDir: resolve(output, 'renderer'), emptyOutDir: true } })
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'cuedeck-render-core-qa', version: '0.1.0', main: 'main.cjs' }))
console.log(output)
