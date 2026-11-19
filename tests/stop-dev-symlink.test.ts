import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { expect, it } from 'vitest'

it('finds and stops a worktree Electron at the resolved path without invoking a shell', () => {
  const source = readFileSync(new URL('../scripts/stop-dev.cjs', import.meta.url), 'utf8')
  const root = '/repo/generated/worktree', resolved = '/repo/node_modules/electron/dist'
  let alive = true
  const kills: string[] = []
  vm.runInNewContext(source, {
    __dirname: root+'/scripts', process: {platform: 'darwin'}, console,
    require(name: string) {
      if(name==='node:path')return path
      if(name==='node:fs')return {realpathSync: (p: string) => p.endsWith('electron/dist') ? resolved : p}
      if(name==='node:child_process')return {execFileSync: (cmd: string, args: string[]) => {
        const pattern = args.at(-1)!
        if(cmd==='pgrep') {if(alive && new RegExp(pattern).test(resolved+'/Electron.app/Contents/MacOS/Electron'))return '';throw new Error('no matches')}
        if(cmd==='pkill') {kills.push(pattern);if(new RegExp(pattern).test(resolved+'/Electron.app/Contents/MacOS/Electron'))alive=false;return ''}
        throw new Error('unexpected executable '+cmd)
      }}
      throw new Error(name)
    },
  })
  expect(alive).toBe(false)
  expect(kills.some(p => new RegExp(p).test(resolved))).toBe(true)
  expect(kills.every(p => !new RegExp(p).test('/Applications/Other.app/Contents/MacOS/Electron'))).toBe(true)
})
