import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPORT_MATERIAL_LIMIT, ReportMaterialSelection } from '../src/main/report-materials'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cuedeck-report-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('requires a current picker token and invalidates old consent on reselection', async () => {
  const selection = new ReportMaterialSelection()
  const path = join(root, 'presentation.pptx')
  await writeFile(path, 'example')
  await expect(selection.read(path)).rejects.toThrow()
  const first = await selection.select([path])
  const second = await selection.select([path])
  await expect(selection.read(first.token)).rejects.toThrow()
  expect((await selection.read(second.token))[0].data.toString()).toBe('example')
  selection.clear()
  await expect(selection.read(second.token)).rejects.toThrow()
})
it('preserves duplicate names and Unicode without adding neighbouring notes or media', async () => {
  const selection = new ReportMaterialSelection()
  await mkdir(join(root, 'other'))
  const a = join(root, 'Доклад.pptx'), b = join(root, 'other', 'Доклад.pptx')
  await writeFile(a, 'first'); await writeFile(b, 'second')
  await writeFile(a + '.notes.json', 'private notes')
  const chosen = await selection.select([a, b, a])
  expect(chosen.bytes).toBe(11)
  const files = await selection.read(chosen.token)
  expect(files.map(f => f.name)).toEqual(['materials/1/Доклад.pptx', 'materials/2/Доклад.pptx'])
  expect(files.map(f => f.data.toString())).toEqual(['first', 'second'])
})
it('rejects oversized, missing and changed files instead of silently producing a partial report', async () => {
  const selection = new ReportMaterialSelection(), path = join(root, 'clip.mp4')
  await writeFile(path, 'x')
  const chosen = await selection.select([path])
  await writeFile(path, 'changed')
  await expect(selection.read(chosen.token)).rejects.toThrow()
  await truncate(path, REPORT_MATERIAL_LIMIT + 1)
  await expect(selection.select([path])).rejects.toThrow()
  await expect(selection.read(chosen.token)).rejects.toThrow()
  await expect(selection.select([join(root, 'missing')])).rejects.toThrow()
  await expect(selection.select([root])).rejects.toThrow()
})

it('makes picked names portable to Windows without adding extra files or exposing source paths', async () => {
  const selection = new ReportMaterialSelection()
  const path = join(root, 'CON.mp4')
  await writeFile(path, 'clip')
  const chosen = await selection.select([path])
  const files = await selection.read(chosen.token)
  expect(files[0].name).toBe('materials/1/_CON.mp4')
  expect(files[0]).not.toHaveProperty('sourcePath')
  const internal = await selection.readWithSources(chosen.token)
  expect(internal[0].sourcePath).toBe(path)
})
