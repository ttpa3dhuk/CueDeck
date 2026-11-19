import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import ts from 'typescript'

it('only reads declared GIFs of the requested active deck, with size and path checks', async () => {
  const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const from = source.indexOf("ipcMain.handle('pptx:read-gif'")
  const body = source.slice(from, source.indexOf("ipcMain.handle('pptx:backend'", from))
  let handler!: (...args: unknown[]) => Promise<unknown>
  let size = 100
  const state = {fileKind: 'pptx', pdfSha1: 'program-sha', slideMedia: [{kind: 'gif', file: 'a.gif'}, {kind: 'video', file: 'b.mp4'}], preview: {kind: 'pptx', sha1: 'preview-sha', slideMedia: [{kind: 'gif', file: 'c.gif'}]}}
  const read = vi.fn(async () => new Uint8Array([1]))
  const deps = {ipcMain: {handle: (_: string, fn: typeof handler) => {handler=fn}}, store: {get: () => state},
    mediaDirFor: (sha: string) => '/cache/'+sha, join: (...p: string[]) => p.join('/'),
    stat: async () => ({isFile: () => true, size}), readFile: read}
  new Function(...Object.keys(deps), ts.transpile(body, {target: ts.ScriptTarget.ES2022}))(...Object.values(deps))
  expect(await handler(null, 'a.gif', 'program-sha', 'program')).toEqual(new Uint8Array([1]))
  expect(await handler(null, 'c.gif', 'preview-sha', 'preview')).toEqual(new Uint8Array([1]))
  for(const args of [['../a.gif','program-sha','program'], ['a.gif','old-sha','program'], ['b.mp4','program-sha','program'], ['c.gif','preview-sha','program'], ['a.gif','program-sha','other']]) {
    expect(await handler(null, ...args)).toBeNull()
  }
  size=64*1024*1024+1
  expect(await handler(null, 'a.gif','program-sha','program')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
})
