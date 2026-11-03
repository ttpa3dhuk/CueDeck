import { beforeEach, expect, it, vi } from 'vitest'
const fs = vi.hoisted(() => ({ writeFile: vi.fn(), rename: vi.fn() }))
vi.mock('node:fs/promises', () => ({ ...fs, readFile: vi.fn() }))
import { flushProjectWrites, saveProjectFile } from '../src/main/project'
const data = { playlist: [], keyVisualPath: null }
beforeEach(async () => {
  await flushProjectWrites()
  fs.writeFile.mockReset().mockResolvedValue(undefined)
  fs.rename.mockReset().mockResolvedValue(undefined)
})
it('shutdown drain waits until an in-flight autosave has renamed the final project', async () => {
  let finishRename!: () => void
  fs.rename.mockImplementationOnce(() => new Promise<void>(resolve => { finishRename = resolve }))
  const write = saveProjectFile('/show.pdpres', data)
  await vi.waitFor(() => expect(fs.rename).toHaveBeenCalledOnce())
  let drained = false
  const flush = flushProjectWrites().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  finishRename()
  await Promise.all([write, flush])
  expect(drained).toBe(true)
})
it('failed writes reject their caller but do not deadlock draining or subsequent saves', async () => {
  fs.writeFile.mockRejectedValueOnce(new Error('disk full'))
  await expect(saveProjectFile('/show.pdpres', data)).rejects.toThrow('disk full')
  await flushProjectWrites()
  expect(fs.rename).not.toHaveBeenCalled()
  await saveProjectFile('/show.pdpres', data)
  await flushProjectWrites()
  expect(fs.rename).toHaveBeenCalledOnce()
})
