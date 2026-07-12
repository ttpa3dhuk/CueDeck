import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// pptx-media резолвит pptx-cache через electron app.getPath('userData').
const TEST_USER_DATA = join(tmpdir(), 'cuedeck-pptx-media-test')
vi.mock('electron', () => ({
  app: { getPath: () => TEST_USER_DATA },
}))

import { mediaDirFor, preparePptxMedia } from '../src/main/pptx-media'
import { cachedPdfPathFor } from '../src/main/pptx-converter'

// Реальная преза: слайд 1 — титул; слайд 2 — билд из 3 кликов по абзацам;
// слайд 3 — видео media1.mp4 (H.264, ~158 МБ); слайд 4 — пустой.
// Файл живёт вне git — без него блок скипается, а не падает.
const SAMPLE = join(__dirname, '..', 'resources', 'Презентация1.pptx')
const SHA1 = 'testsha1'

afterAll(async () => {
  await rm(TEST_USER_DATA, { recursive: true, force: true })
})

describe.skipIf(!existsSync(SAMPLE))('preparePptxMedia (реальный PPTX: видео + анимации)', () => {
  it('находит видео с прямоугольником плейсхолдера; страница — с учётом шагов', async () => {
    const prepared = await preparePptxMedia(SAMPLE, SHA1)

    expect(prepared.slideMedia).toHaveLength(1)
    const m = prepared.slideMedia[0]
    // Слайд 2 (3 клика) разворачивается в страницы 2–5 → видео-слайд 3 = страница 6.
    expect(m.slide).toBe(6)
    expect(m.file).toBe('media1.mp4')
    // EMU из slide3.xml: off 2227263/1825625, ext 7735887/4351338 при 12192000×6858000
    expect(m.rect.x).toBeCloseTo(0.183, 2)
    expect(m.rect.y).toBeCloseTo(0.266, 2)
    expect(m.rect.w).toBeCloseTo(0.634, 2)
    expect(m.rect.h).toBeCloseTo(0.634, 2)
  })

  it('извлекает ролик в pptx-cache целиком', async () => {
    await preparePptxMedia(SAMPLE, SHA1)
    const extracted = join(mediaDirFor(SHA1), 'media1.mp4')
    const src = await stat(SAMPLE)
    const out = await stat(extracted)
    // mp4 в zip лежит почти без сжатия — размер сопоставим с исходником
    expect(out.size).toBeGreaterThan(100_000_000)
    expect(out.size).toBeLessThan(src.size)
  })

  it('собирает валидную пересобранную копию: без веса видео, с шаг-страницами', async () => {
    const prepared = await preparePptxMedia(SAMPLE, SHA1)
    expect(prepared.temporary).toBe(true)
    const rebuilt = prepared.convertSource
    expect(existsSync(rebuilt)).toBe(true)
    // 162 МБ → единицы МБ: всё видео выброшено
    expect((await stat(rebuilt)).size).toBeLessThan(10_000_000)
    // Целостность zip проверяет сторонний инструмент, не наш же код
    const listing = execFileSync('unzip', ['-l', rebuilt], { encoding: 'utf8' })
    execFileSync('unzip', ['-t', rebuilt], { stdio: 'pipe' })
    // Слайд 2: 3 клика → 3 добавленные шаг-страницы со своими rels
    for (const name of ['slide2_cd1.xml', 'slide2_cd2.xml', 'slide2_cd3.xml']) {
      expect(listing).toContain(`ppt/slides/${name}`)
      expect(listing).toContain(`ppt/slides/_rels/${name}.rels`)
    }
    // Видео-слайд и пустой слайд не разворачиваются
    expect(listing).not.toContain('slide3_cd')
    expect(listing).not.toContain('slide4_cd')
  })

  it('при готовом PDF в кэше отдаёт оригинал без пересборки', async () => {
    await preparePptxMedia(SAMPLE, SHA1) // прогрев: manifest записан
    await writeFile(cachedPdfPathFor(SHA1), 'fake pdf')
    const prepared = await preparePptxMedia(SAMPLE, SHA1)
    expect(prepared.convertSource).toBe(SAMPLE)
    expect(prepared.temporary).toBe(false)
    expect(prepared.slideMedia).toHaveLength(1)
    expect(prepared.slideMedia[0].slide).toBe(6)
    await rm(cachedPdfPathFor(SHA1), { force: true })
  })
})

describe('preparePptxMedia (деградация)', () => {
  it('не-pptx расширение → оригинал без разбора', async () => {
    const prepared = await preparePptxMedia('/nowhere/deck.odp', 'sha-odp')
    expect(prepared).toEqual({ slideMedia: [], convertSource: '/nowhere/deck.odp', temporary: false })
  })

  it('битый zip → оригинал без падения', async () => {
    const broken = join(tmpdir(), 'cuedeck-broken-test.pptx')
    await writeFile(broken, 'this is not a zip at all')
    const prepared = await preparePptxMedia(broken, 'sha-broken')
    expect(prepared.slideMedia).toEqual([])
    expect(prepared.convertSource).toBe(broken)
    await rm(broken, { force: true })
  })
})
