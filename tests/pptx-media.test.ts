import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    expect(prepared).toEqual({
      slideMedia: [],
      pageNotes: {},
      fonts: [],
      convertSource: '/nowhere/deck.odp',
      temporary: false,
    })
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

// ── 2.23: заметки докладчика ────────────────────────────────────────────────
// Синтетический PPTX собирается в тесте (*.pptx в git не попадают): только
// части, которые читает разборщик. Слайды:
//   1 — заметка из двух абзацев, мягкий перенос, сущности, номер слайда в заметках;
//   2 — СКРЫТЫЙ, с роликом и заметкой — страниц не занимает;
//   3 — два клика по абзацам → страницы 2–4, заметка на все три;
//   4 — без заметок; 5 — заметка есть, но пустая (только пробелы).

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const notesXml = (body: string): string =>
  `<p:notes ${NS}><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="img"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
  `<p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="4" name="num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr>` +
  `<p:txBody><a:bodyPr/><a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:notes>`

const slideXml = (extra = '', show = ''): string =>
  `<p:sld ${NS}${show}><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="5" name="text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:txBody><a:bodyPr/><a:p><a:r><a:t>A</a:t></a:r></a:p><a:p><a:r><a:t>B</a:t></a:r></a:p></p:txBody></p:sp>` +
  `${extra}</p:spTree></p:cSld></p:sld>`

const click = (para: number): string =>
  `<p:par><p:cTn><p:childTnLst><p:par><p:cTn><p:childTnLst>` +
  `<p:par><p:cTn presetClass="entr" nodeType="clickEffect"><p:childTnLst><p:set><p:cBhvr><p:tgtEl>` +
  `<p:spTgt spid="5"><p:txEl><p:pRg st="${para}" end="${para}"/></p:txEl></p:spTgt>` +
  `</p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par>` +
  `</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`

const TIMING =
  `<p:timing><p:tnLst><p:par><p:cTn nodeType="tmRoot"><p:childTnLst>` +
  `<p:seq><p:cTn nodeType="mainSeq"><p:childTnLst>${click(0)}${click(1)}</p:childTnLst></p:cTn></p:seq>` +
  `</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`

const VIDEO_PIC =
  `<p:pic><p:nvPicPr><p:cNvPr id="6" name="video"/><p:cNvPicPr/>` +
  `<p:nvPr><a:videoFile r:link="rIdV"/></p:nvPr></p:nvPicPr></p:pic>`

const slideRels = (n: number | null, video = false): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  (n ? `<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>` : '') +
  (video ? `<Relationship Id="rIdV" Type="${REL}/video" Target="../media/media1.mp4"/>` : '') +
  `</Relationships>`

const para = (runs: string): string => `<a:p>${runs}</a:p>`
const run = (t: string): string => `<a:r><a:rPr lang="ru-RU"/><a:t>${t}</a:t></a:r>`

const NOTES_DECK: Record<string, string> = {
  '[Content_Types].xml':
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  'ppt/presentation.xml':
    `<p:presentation ${NS}><p:sldIdLst>` +
    [1, 2, 3, 4, 5].map((i) => `<p:sldId id="${255 + i}" r:id="rId${i}"/>`).join('') +
    `</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  'ppt/_rels/presentation.xml.rels':
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    [1, 2, 3, 4, 5]
      .map((i) => `<Relationship Id="rId${i}" Type="${REL}/slide" Target="slides/slide${i}.xml"/>`)
      .join('') +
    `</Relationships>`,
  'ppt/slides/slide1.xml': slideXml(),
  'ppt/slides/slide2.xml': slideXml(VIDEO_PIC, ' show="0"'),
  'ppt/slides/slide3.xml': slideXml().replace('</p:sld>', `${TIMING}</p:sld>`),
  'ppt/slides/slide4.xml': slideXml(),
  'ppt/slides/slide5.xml': slideXml(),
  'ppt/slides/_rels/slide1.xml.rels': slideRels(1),
  'ppt/slides/_rels/slide2.xml.rels': slideRels(2, true),
  'ppt/slides/_rels/slide3.xml.rels': slideRels(3),
  'ppt/slides/_rels/slide4.xml.rels': slideRels(null),
  'ppt/slides/_rels/slide5.xml.rels': slideRels(5),
  'ppt/notesSlides/notesSlide1.xml': notesXml(
    para(run('Поздороваться') + run(' с залом')) +
      para(run('Цены &amp; сроки &lt;2026&gt;') + '<a:br/>' + run('&#1071; &#x42;')) +
      para('') +
      para(''),
  ),
  'ppt/notesSlides/notesSlide2.xml': notesXml(para(run('СКРЫТЫЙ'))),
  'ppt/notesSlides/notesSlide3.xml': notesXml(para(run('Про билд'))),
  'ppt/notesSlides/notesSlide5.xml': notesXml(para(run('   '))),
  'ppt/media/media1.mp4': 'fake video',
}

async function buildDeck(dir: string, files: Record<string, string>): Promise<string> {
  await rm(dir, { recursive: true, force: true })
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, 'src', name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  }
  const out = join(dir, 'deck.pptx')
  execFileSync('zip', ['-qr', out, '.'], { cwd: join(dir, 'src') })
  return out
}

describe('preparePptxMedia: заметки докладчика (2.23)', () => {
  const DIR = join(tmpdir(), 'cuedeck-notes-deck')
  afterAll(async () => {
    await rm(DIR, { recursive: true, force: true })
  })

  it('заметки по страницам PDF: абзацы, переносы, сущности; шаги; скрытый слайд пропущен', async () => {
    const deck = await buildDeck(DIR, NOTES_DECK)
    const prepared = await preparePptxMedia(deck, 'sha-notes')
    expect(prepared.pageNotes).toEqual({
      1: 'Поздороваться с залом\nЦены & сроки <2026>\nЯ B',
      2: 'Про билд',
      3: 'Про билд',
      4: 'Про билд',
    })
    // Ролик скрытого слайда: оверлея нет (страницы нет), но из копии вырезан.
    expect(prepared.slideMedia).toEqual([])
    expect(prepared.temporary).toBe(true)
    await rm(prepared.convertSource, { force: true })
  })

  it('заметки лежат в manifest: второе открытие отдаёт их из кэша', async () => {
    const deck = await buildDeck(DIR, NOTES_DECK)
    await preparePptxMedia(deck, 'sha-notes-cache') // прогрев
    await writeFile(cachedPdfPathFor('sha-notes-cache'), 'fake pdf')
    const prepared = await preparePptxMedia(deck, 'sha-notes-cache')
    expect(prepared.temporary).toBe(false)
    expect(prepared.pageNotes[1]).toMatch(/^Поздороваться/)
    expect(prepared.pageNotes[4]).toBe('Про билд')
  })

  it('манифест прошлой версии: заметки дочитываются, готовый PDF не пересоздаётся', async () => {
    const deck = await buildDeck(DIR, NOTES_DECK)
    const sha = 'sha-notes-v2'
    await mkdir(join(TEST_USER_DATA, 'pptx-cache'), { recursive: true })
    await writeFile(
      join(TEST_USER_DATA, 'pptx-cache', `${sha}.media.json`),
      JSON.stringify({ version: 2, rebuilt: true, slideMedia: [] }),
    )
    await writeFile(cachedPdfPathFor(sha), 'pdf from v2')
    const prepared = await preparePptxMedia(deck, sha)
    expect(prepared.temporary).toBe(false)
    expect(prepared.pageNotes[2]).toBe('Про билд')
    expect(existsSync(cachedPdfPathFor(sha))).toBe(true)
  })
})
