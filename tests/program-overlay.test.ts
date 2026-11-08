import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { programOverlay } from '../src/shared/program-overlay'
import { loadProjectFile, saveProjectFile } from '../src/main/project'
import { transferProject } from '../src/main/project-transfer'

let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = '' })
describe('one program overlay', () => {
  it('bounds normalized geometry, text length, font and colors without enabling malformed state', () => {
    expect(programOverlay(null).enabled).toBe(false)
    const overlay = programOverlay({ enabled: true, text: 'x'.repeat(2100), x: 2, y: -1, w: 99, h: Infinity,
      fontSize: 1000, opacity: -5, color: 'url(evil)', background: '#112233' })
    expect(overlay).toMatchObject({ enabled: true, x: .95, y: 0, fontSize: 240, opacity: 0, color: '#ffffff', background: '#112233' })
    expect(overlay.w).toBeCloseTo(.05)
    expect(overlay.text.length).toBe(2000)
  })
  it('saves relative image paths and text geometry in the project', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cuedeck-overlay-'))
    const image = join(directory, 'title.png'), file = join(directory, 'show.pdpres')
    const overlay = programOverlay({ enabled: true, mode: 'image', path: image, text: 'Title', x: .12 })
    await saveProjectFile(file, { playlist: [], keyVisualPath: null, programOverlay: overlay })
    expect(JSON.parse(await readFile(file, 'utf8')).programOverlay.path).toBe('title.png')
    expect((await loadProjectFile(file)).programOverlay).toEqual(overlay)
  })
  it('includes overlay media in a transferred project and verifies the copied file', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cuedeck-overlay-transfer-'))
    const image = join(directory, 'title.png'), parent = join(directory, 'usb')
    await writeFile(image, 'synthetic overlay bytes'); await mkdir(parent)
    const result = await transferProject({ parent, name: 'show', playlist: [], keyVisualPath: null,
      programOverlay: programOverlay({ enabled: true, mode: 'image', path: image }), prepare: async () => [], progress: () => undefined })
    const loaded = await loadProjectFile(result.path)
    expect(loaded.programOverlay?.path).not.toBe(image)
    expect(await readFile(loaded.programOverlay!.path!, 'utf8')).toBe('synthetic overlay bytes')
    expect(loaded.programOverlay?.enabled).toBe(true)
  })
})
