import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// pptx-media резолвит pptx-cache через electron app.getPath('userData').
const TEST_USER_DATA = join(tmpdir(), 'cuedeck-pptx-media-test')
vi.mock('electron', () => ({
  app: { getPath: () => TEST_USER_DATA },
}))

import { mediaDirFor, parseVideoPlayback, preparePptxMedia, staticPptxNotes } from '../src/main/pptx-media'
import { cachedPdfPathFor } from '../src/main/pptx-converter'
import { isAnimatedGif } from '../src/shared/gif'
import { slideMediaAt } from '../src/renderer/shared/video'
import { PPTX_MANIFEST_VERSION } from '../src/shared/presentation-preparation'

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

async function buildDeck(dir: string, files: Record<string, string | Buffer>): Promise<string> {
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

describe('PPTX animated GIF', () => {
  const dir = join(tmpdir(), 'cuedeck-gif-deck')
  const gif = Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7', 'base64')
  const pic = '<p:pic><p:nvPicPr><p:cNvPr id="6" name="GIF"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdG"/></p:blipFill><p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:srcRect l="10000" r="20000"/></p:spPr></p:pic>'
  const files = (body: string, hidden = false): Record<string, string | Buffer> => ({
    ...NOTES_DECK,
    'ppt/slides/slide1.xml': slideXml(body, hidden ? ' show="0"' : ''),
    'ppt/slides/_rels/slide1.xml.rels': slideRels(null).replace('</Relationships>', `<Relationship Id="rIdG" Type="${REL}/image" Target="../media/animated.gif"/></Relationships>`),
    'ppt/media/animated.gif': gif,
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reads GIF blocks and rejects truncated or static images', () => {
    expect(isAnimatedGif(gif)).toBe(true)
    expect(isAnimatedGif(gif.subarray(0, -1))).toBe(false)
    expect(isAnimatedGif(Buffer.from('GIF89a'))).toBe(false)
    const last = gif.lastIndexOf(Buffer.from([0x21, 0xf9]))
    expect(isAnimatedGif(Buffer.concat([gif.subarray(0, last), Buffer.from([0x3b])]))).toBe(false)
  })
  it('extracts original animation, keeps geometry/crop and removes the static underlay', async () => {
    const deck = await buildDeck(dir, files(pic))
    const result = await preparePptxMedia(deck, 'gif-basic')
    const media = result.slideMedia.filter(m => m.kind === 'gif')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ slide: 1, rect: { x: .1, y: .1, w: .5, h: .5 }, crop: { left: .1, right: .2, top: 0, bottom: 0 } })
    expect(await readFile(join(mediaDirFor('gif-basic'), media[0].file))).toEqual(gif)
    const xml = execFileSync('unzip', ['-p', result.convertSource, 'ppt/slides/slide1.xml'], { encoding: 'utf8' })
    expect(xml).not.toContain('name="GIF"')
    expect(slideMediaAt('pptx', media, 1)).toBeUndefined()
  })
  it('handles two GIFs without replacing the independent video', async () => {
    const separateVideo = VIDEO_PIC.replace('id="6"', 'id="8"').replace('</p:pic>', '<p:spPr><a:xfrm><a:off x="0" y="6000000"/><a:ext cx="6096000" cy="800000"/></a:xfrm></p:spPr></p:pic>')
    const deckFiles = files(pic + pic.replace('id="6"', 'id="7"').replace('x="1219200"', 'x="8000000"') + separateVideo)
    deckFiles['ppt/slides/_rels/slide1.xml.rels'] = String(deckFiles['ppt/slides/_rels/slide1.xml.rels']).replace('</Relationships>', `<Relationship Id="rIdV" Type="${REL}/video" Target="../media/media1.mp4"/></Relationships>`)
    const result = await preparePptxMedia(await buildDeck(dir, deckFiles), 'gif-two-video')
    expect(result.slideMedia.filter(m => m.kind === 'gif')).toHaveLength(2)
    expect(slideMediaAt('pptx', result.slideMedia, 1)?.file).toBe('media1.mp4')
  })
  it('reads geometry after Office metadata extensions on GIFs and foreground pictures', async () => {
    const metadata = '<a:extLst><a:ext uri="{OFFICE-METADATA}"/></a:extLst>'
    const officePic = pic.replace('<p:cNvPr id="6" name="GIF"/>', `<p:cNvPr id="6" name="GIF">${metadata}</p:cNvPr>`)
    const foreground = `<p:pic><p:nvPicPr><p:cNvPr id="8" name="separate">${metadata}</p:cNvPr></p:nvPicPr><p:spPr><a:xfrm><a:off x="10000000" y="100000"/><a:ext cx="100000" cy="100000"/></a:xfrm></p:spPr></p:pic>`
    const result = await preparePptxMedia(await buildDeck(dir, files(officePic + foreground)), 'gif-office-ext')
    expect(result.slideMedia).toMatchObject([{ kind: 'gif', rect: { x: .1, y: .1, w: .5, h: .5 } }])
    const rebuilt = execFileSync('unzip', ['-p', result.convertSource, 'ppt/slides/slide1.xml'], { encoding: 'utf8' })
    expect(rebuilt).not.toContain('name="GIF"')
    expect(rebuilt).toContain('name="separate"')
  })
  it('does not animate hidden slides or unsupported group coordinates', async () => {
    for (const [body, hidden, sha] of [[pic, true, 'gif-hidden'], [`<p:grpSp>${pic}</p:grpSp>`, false, 'gif-group']] as const) {
      const result = await preparePptxMedia(await buildDeck(dir, files(body, hidden)), sha)
      expect(result.slideMedia.filter(m => m.kind === 'gif')).toHaveLength(0)
    }
  })
  it('keeps a static fallback when a foreground object overlaps the GIF', async () => {
    const cover = '<p:sp><p:nvSpPr><p:cNvPr id="8" name="foreground"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr></p:sp>'
    const result = await preparePptxMedia(await buildDeck(dir, files(pic + cover)), 'gif-foreground')
    expect(result.slideMedia.some(m => m.kind === 'gif')).toBe(false)
  })
  it('invalidates an old PDF containing a static GIF and reloads the new manifest', async () => {
    const deck = await buildDeck(dir, files(pic))
    await preparePptxMedia(deck, 'gif-old-cache')
    const manifest = join(dirname(mediaDirFor('gif-old-cache')), 'gif-old-cache.media.json')
    const old = JSON.parse(await readFile(manifest, 'utf8')); old.version = 7
    await writeFile(manifest, JSON.stringify(old))
    await writeFile(cachedPdfPathFor('gif-old-cache'), 'old static GIF PDF')
    expect((await preparePptxMedia(deck, 'gif-old-cache')).temporary).toBe(true)
    expect((await preparePptxMedia(deck, 'gif-old-cache')).slideMedia.some(m => m.kind === 'gif')).toBe(true)
  })
})

describe('PPTX chart previews and authored slide numbers', () => {
  const dir = join(tmpdir(), 'cuedeck-chart-preview-deck')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const picture = '<p:pic><p:nvPicPr><p:cNvPr id="22" name="Chart preview"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPreview"/></p:blipFill><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr></p:pic>'
  const alternate = (uri = 'http://schemas.microsoft.com/office/drawing/2014/chartex') =>
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="cx1"><p:graphicFrame><a:graphic><a:graphicData uri="${uri}"><cx:chart r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame></mc:Choice><mc:Fallback>${picture}</mc:Fallback></mc:AlternateContent>`
  const files = (body: string, preview: Buffer | null = png) => ({
    ...NOTES_DECK,
    'ppt/slides/slide1.xml': slideXml(body),
    'ppt/slides/_rels/slide1.xml.rels': slideRels(null).replace('</Relationships>', `<Relationship Id="rIdPreview" Type="${REL}/image" Target="../media/chart.png"/></Relationships>`),
    ...(preview ? { 'ppt/media/chart.png': preview } : {}),
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('keeps native charts and embedded media for PowerPoint while expanding click steps', async () => {
    const result = await preparePptxMedia(await buildDeck(dir, files(alternate())), 'powerpoint-native-chart', undefined, 'powerpoint')
    const xml = execFileSync('unzip', ['-p', result.convertSource, 'ppt/slides/slide1.xml'], { encoding: 'utf8' })
    expect(xml).toContain(alternate())
    expect(execFileSync('unzip', ['-p', result.convertSource, 'ppt/media/media1.mp4']).toString()).toBe('fake video')
    const steps = await staticPptxNotes(result.convertSource)
    expect(steps.visibleSlides).toBe(6)
    expect(result.pageNotes[2]).toBe('Про билд')
    expect(result.pageNotes[4]).toBe('Про билд')
    const firstStep = execFileSync('unzip', ['-p', result.convertSource, 'ppt/slides/slide3.xml'], { encoding: 'utf8' })
    expect(firstStep).not.toContain('<p:timing>')
    expect(firstStep).toContain('val="0"')
  })

  it('uses the saved Office chart image without changing its geometry or unrelated objects', async () => {
    const result = await preparePptxMedia(await buildDeck(dir, files(alternate() + '<p:sp id="annotation"/>')), 'chart-preview')
    const xml = execFileSync('unzip', ['-p', result.convertSource, 'ppt/slides/slide1.xml'], { encoding: 'utf8' })
    expect(xml).not.toContain('cx:chart')
    expect(xml).not.toContain('mc:AlternateContent')
    expect(xml).toContain('r:embed="rIdPreview"')
    expect(xml).toContain('<a:off x="100" y="200"/><a:ext cx="300" cy="400"/>')
    expect(xml).toContain('<p:sp id="annotation"/>')
  })

  it.each([null, Buffer.from('not a raster')])('retains chart definitions when the saved image is missing or invalid', async preview => {
    const result = await preparePptxMedia(await buildDeck(dir, files(alternate(), preview)), 'chart-no-image')
    const xml = execFileSync('unzip', ['-p', result.convertSource, 'ppt/slides/slide1.xml'], { encoding: 'utf8' })
    expect(xml).toContain(alternate())
  })

  it('does not flatten unrelated AlternateContent', async () => {
    const result = await preparePptxMedia(await buildDeck(dir, files(alternate('other-drawing-type'))), 'chart-unrelated')
    expect(execFileSync('unzip', ['-p', result.convertSource, 'ppt/slides/slide1.xml'], { encoding: 'utf8' })).toContain(alternate('other-drawing-type'))
  })

  it('freezes only slide-number fields on all build pages and subsequent source slides', async () => {
    const field = (value: string, type = 'slidenum') => `<a:fld id="field" type="${type}"><a:rPr sz="2400"/><a:t>${value}</a:t></a:fld>`
    const deckFiles = { ...NOTES_DECK,
      'ppt/slides/slide3.xml': slideXml(`<p:sp><p:txBody><a:p>${field('7')}${field('date', 'datetime1')}</a:p></p:txBody></p:sp>`).replace('</p:sld>', TIMING + '</p:sld>'),
      'ppt/slides/slide4.xml': slideXml(`<p:sp><p:txBody><a:p>${field('8')}</a:p></p:txBody></p:sp>`),
    }
    const result = await preparePptxMedia(await buildDeck(dir, deckFiles), 'number-builds')
    for (const name of ['slide3.xml', 'slide3_cd1.xml', 'slide3_cd2.xml', 'slide4.xml']) {
      const xml = execFileSync('unzip', ['-p', result.convertSource, `ppt/slides/${name}`], { encoding: 'utf8' })
      expect(xml).not.toContain('type="slidenum"')
      expect(xml).toContain(`<a:r><a:rPr sz="2400"/><a:t>${name.startsWith('slide3') ? '7' : '8'}</a:t></a:r>`)
      if (name.startsWith('slide3')) expect(xml).toContain('type="datetime1"')
    }
  })

  it('invalidates a v9 PDF even when only the chart preview changes', async () => {
    const sha = 'chart-cache-v9', deck = await buildDeck(dir, files(alternate()))
    await preparePptxMedia(deck, sha)
    const path = join(dirname(mediaDirFor(sha)), `${sha}.media.json`)
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.version = 9
    await writeFile(path, JSON.stringify(manifest)); await writeFile(cachedPdfPathFor(sha), 'old line-chart PDF')
    const result = await preparePptxMedia(deck, sha)
    expect(result.temporary).toBe(true)
    expect(existsSync(cachedPdfPathFor(sha))).toBe(false)
  })
})

describe('preparePptxMedia: заметки докладчика (2.23)', () => {
  const DIR = join(tmpdir(), 'cuedeck-notes-deck')
  afterAll(async () => {
    await rm(DIR, { recursive: true, force: true })
  })

  it('static PowerPoint mapping keeps authored slide order, skips hidden slides and does not repeat animation steps', async () => {
    const deck = await buildDeck(DIR, NOTES_DECK)
    expect(await staticPptxNotes(deck)).toEqual({
      visibleSlides: 4,
      allSlides: 5,
      notes: { 1: 'Поздороваться с залом\nЦены & сроки <2026>\nЯ B', 2: 'Про билд' },
    })
  })

  it('maps the source Fade to the first expanded page only and retains it in cache', async () => {
    const files = { ...NOTES_DECK, 'ppt/slides/slide3.xml': NOTES_DECK['ppt/slides/slide3.xml'].replace('</p:sld>', '<p:transition p14:dur="350"><p:fade/></p:transition></p:sld>') }
    const deck = await buildDeck(DIR, files)
    expect((await preparePptxMedia(deck, 'fade-steps')).slideTransitions).toEqual({ 1: 0, 2: 350, 5: 0, 6: 0 })
    expect((await preparePptxMedia(deck, 'fade-steps')).slideTransitions).toEqual({ 1: 0, 2: 350, 5: 0, 6: 0 })
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


describe('preparePptxMedia: video geometry and source crop', () => {
  const DIR = join(tmpdir(), 'cuedeck-video-crop-deck')
  afterAll(async () => { await rm(DIR, { recursive: true, force: true }) })

  async function cropDeck(crop: string) {
    const pic = VIDEO_PIC.replace('</p:pic>',
      `<p:blipFill><a:srcRect ${crop}/></p:blipFill>` +
      '<p:spPr><a:xfrm><a:off x="-121920" y="-137160"/>' +
      '<a:ext cx="12435840" cy="7132320"/></a:xfrm></p:spPr></p:pic>')
    return buildDeck(DIR, { ...NOTES_DECK,
      'ppt/slides/slide1.xml': slideXml(pic),
      'ppt/slides/_rels/slide1.xml.rels': slideRels(1, true),
    })
  }

  it('preserves off-slide geometry and the 6.476% bottom crop across cache reads', async () => {
    const deck = await cropDeck('b="6476"')
    const sha = 'sha-video-crop'
    const prepared = await preparePptxMedia(deck, sha)
    const media = prepared.slideMedia[0]
    expect(media.rect).toEqual({ x: -0.01, y: -0.02, w: 1.02, h: 1.04 })
    expect(media.crop).toEqual({ left: 0, top: 0, right: 0, bottom: 0.06476 })
    await writeFile(cachedPdfPathFor(sha), 'cached PDF')
    expect((await preparePptxMedia(deck, sha)).slideMedia).toEqual(prepared.slideMedia)
  })

  it('upgrades a v5 manifest without invalidating its unchanged PDF', async () => {
    const deck = await cropDeck('l="1000" t="2000" r="3000" b="6476"')
    const sha = 'sha-video-crop-v5'
    const manifestPath = join(TEST_USER_DATA, 'pptx-cache', `${sha}.media.json`)
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ version: 5, rebuilt: true, slideMedia: [], fonts: [], pageNotes: {} }))
    await writeFile(cachedPdfPathFor(sha), 'unchanged PDF')
    const prepared = await preparePptxMedia(deck, sha)
    expect(prepared.temporary).toBe(false)
    expect(prepared.slideMedia[0].crop).toEqual({ left: 0.01, top: 0.02, right: 0.03, bottom: 0.06476 })
    expect(await readFile(cachedPdfPathFor(sha), 'utf8')).toBe('unchanged PDF')
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).version).toBe(PPTX_MANIFEST_VERSION)
  })

  it('ignores a malformed or empty source rectangle instead of emitting invalid crop', async () => {
    const deck = await cropDeck('l="NaN" b="100000"')
    expect((await preparePptxMedia(deck, 'sha-video-crop-invalid')).slideMedia[0].crop).toBeUndefined()
  })
})


describe('PPTX video playback timing', () => {
  const command = '<p:cmd cmd="playFrom(0.0)"><p:cBhvr><p:tgtEl><p:spTgt spid="6"/></p:tgtEl></p:cBhvr></p:cmd>'
  const effect = (nodeType = 'withEffect', delay = '0') => `<p:par><p:cTn nodeType="${nodeType}"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>${command}</p:childTnLst></p:cTn></p:par>`
  const group = (effects: string, entry = true) => '<p:par><p:cTn><p:stCondLst>' +
    (entry ? '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : '<p:cond delay="indefinite"/>') +
    `</p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par>`
  const seq = (groups: string, type = 'mainSeq') => `<p:seq><p:cTn id="2" nodeType="${type}"><p:childTnLst>${groups}</p:childTnLst></p:cTn></p:seq>`
  const timing = (content: string) => `<p:timing><p:tnLst>${content}</p:tnLst></p:timing>`

  it('recognizes an immediate withEffect entry command and matching indefinite loop', () => {
    const media = '<p:video><p:cMediaNode><p:cTn repeatCount="indefinite"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="6"/></p:tgtEl></p:cMediaNode></p:video>'
    expect(parseVideoPlayback(timing(seq(group(effect())) + media), '6')).toEqual({ autoPlay: true, loop: true })
    expect(parseVideoPlayback(timing(media), '7')).toEqual({ autoPlay: false, loop: false })
  })

  it.each([
    seq(group(effect('clickEffect'))),
    seq(group(effect(), false)),
    seq(group(effect(), false) + group(effect())),
    seq(group(effect()), 'interactiveSeq'),
    seq(group(effect('withEffect', '500'))),
    seq(group(effect('clickEffect') + effect('afterEffect'))),
  ])('keeps manual, later-click, interactive and delayed commands manual', (xml) => {
    expect(parseVideoPlayback(timing(xml), '6').autoPlay).toBe(false)
  })

  it('accepts immediate direct media start but not interactive or delayed starts', () => {
    const media = (delay: string) => `<p:video><p:cMediaNode><p:cTn><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="6"/></p:tgtEl></p:cMediaNode></p:video>`
    expect(parseVideoPlayback(timing(media('0')), '6').autoPlay).toBe(true)
    expect(parseVideoPlayback(timing(media('100')), '6').autoPlay).toBe(false)
    expect(parseVideoPlayback(timing(seq(media('0'), 'interactiveSeq')), '6').autoPlay).toBe(false)
  })
})


describe('PowerPoint authored object fade', () => {
  const dir = join(tmpdir(), 'cuedeck-build-fade-test')
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })
  const effect = (filter: string, delay = '0') => `<p:timing><p:tnLst><p:seq><p:cTn nodeType="mainSeq"><p:childTnLst><p:par><p:cTn presetClass="entr"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst><p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn dur="500"/><p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:tnLst></p:timing>`
  async function prepare(filter: string, transform = 'flipH="1"', delay = '0') {
    const shape = slideXml().replace('</p:nvSpPr>', '</p:nvSpPr><p:spPr><a:xfrm '+transform+'><a:off x="1219200" y="685800"/><a:ext cx="2438400" cy="1371600"/></a:xfrm></p:spPr>')
    const file = await buildDeck(dir, { ...NOTES_DECK, 'ppt/slides/slide1.xml': shape.replace('</p:sld>', effect(filter, delay)+'</p:sld>') })
    return preparePptxMedia(file, 'build-'+filter+'-'+transform+'-'+delay, undefined, 'powerpoint')
  }
  it('retains 500ms and flipped object bounds on the destination build page', async () => {
    const result = await prepare('fade')
    expect(result.slideBuilds?.[2]).toEqual({ kind: 'fade', durationMs: 500, rect: { x: .1, y: .1, w: expect.closeTo(.2), h: expect.closeTo(.2) } })
  })
  it('keeps distinct wipe/split effects and authored delay', async () => {
    expect((await prepare('wipe(down)')).slideBuilds?.[2]).toMatchObject({kind:'wipe-up',durationMs:500})
    expect((await prepare('barn(inVertical)')).slideBuilds?.[2]).toMatchObject({kind:'split-in-vertical',durationMs:500})
    expect((await prepare('wheel(4)')).slideBuilds).toEqual({})
    expect((await prepare('fade', '', '300')).slideBuilds?.[2]).toMatchObject({kind:'fade',delayMs:300})
  })
  it('falls back to an ordinary step when rotated bounds are not supported', async () => {
    expect((await prepare('fade', 'rot="5400000"')).slideBuilds).toEqual({})
  })
})


it('uses a separate native frame deck when foreground text intersects the picture', async () => {
  const dir = join(tmpdir(), 'cuedeck-fly-layering')
  try {
    const anim = (axis: string, start: string) => `<p:anim calcmode="lin"><p:cBhvr><p:cTn dur="500"/><p:tgtEl><p:spTgt spid="11"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_${axis}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${start}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_${axis}"/></p:val></p:tav></p:tavLst></p:anim>`
    const timing = `<p:timing><p:seq><p:cTn nodeType="mainSeq"><p:childTnLst><p:par><p:cTn presetClass="entr"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${anim('x','#ppt_x')}${anim('y','1+#ppt_h/2')}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:timing>`
    const xf = '<a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="2438400" cy="1371600"/></a:xfrm>'
    const pic = `<p:pic><p:nvPicPr><p:cNvPr id="11"/></p:nvPicPr><p:blipFill><a:blip r:embed="photo"/></p:blipFill><p:spPr>${xf}</p:spPr></p:pic>`
    for (const overlap of [false,true]) {
      const foreground = overlap ? `<p:sp><p:nvSpPr><p:cNvPr id="18"/></p:nvSpPr><p:spPr>${xf}</p:spPr></p:sp>` : ''
      const deck = await buildDeck(dir, {...NOTES_DECK,'ppt/slides/slide1.xml':slideXml(pic+foreground).replace('</p:sld>',timing+'</p:sld>'),
        'ppt/slides/_rels/slide1.xml.rels':slideRels(null).replace('</Relationships>',`<Relationship Id="photo" Type="${REL}/image" Target="../media/photo.jpeg"/></Relationships>`),
        'ppt/media/photo.jpeg':Buffer.from([255,216,255,224])})
      const result = await preparePptxMedia(deck,'fly-layer-'+overlap,undefined,'powerpoint')
      if (overlap) {
        expect(result.slideBuilds?.[2]).toMatchObject({kind:'native-frames',frameCount:16,framesFile:'build-2.pdf'})
        expect(result.nativeFrameSources).toHaveLength(1)
        const native=result.nativeFrameSources![0].sourcePath
        const first=execFileSync('unzip',['-p',native,'ppt/slides/_cuedeck_frame_0.xml'],{encoding:'utf8'})
        const last=execFileSync('unzip',['-p',native,'ppt/slides/_cuedeck_frame_15.xml'],{encoding:'utf8'})
        expect(first).toContain('<p:cNvPr id="18"/>')
        expect(last).toContain('<p:cNvPr id="18"/>')
        expect(first).toContain('y="6858000"')
        expect(last).toContain('y="685800"')
      }
      else expect(result.slideBuilds?.[2]).toMatchObject({kind:'fly-bottom',durationMs:500})
    }
  } finally { await rm(dir,{recursive:true,force:true}) }
})


it('reveals wipe(down) pictures upwards with a fixed bottom edge, as verified against PowerPoint', async () => {
  const dir=join(tmpdir(),'cuedeck-wipe-direction')
  try {
    const pic='<p:pic><p:nvPicPr><p:cNvPr id="11"/></p:nvPicPr><p:blipFill><a:blip r:embed="photo"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="2438400" cy="1371600"/></a:xfrm></p:spPr></p:pic>'
    const timing='<p:timing><p:seq><p:cTn nodeType="mainSeq"><p:childTnLst><p:par><p:cTn presetClass="entr"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:animEffect transition="in" filter="wipe(down)"><p:cBhvr><p:cTn dur="500"/><p:tgtEl><p:spTgt spid="11"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:timing>'
    const deck=await buildDeck(dir,{...NOTES_DECK,'ppt/slides/slide1.xml':slideXml(pic).replace('</p:sld>',timing+'</p:sld>'),
      'ppt/slides/_rels/slide1.xml.rels':slideRels(null).replace('</Relationships>',`<Relationship Id="photo" Type="${REL}/image" Target="../media/photo.jpeg"/></Relationships>`),
      'ppt/media/photo.jpeg':Buffer.from([255,216,255,224])})
    const result=await preparePptxMedia(deck,'wipe-up-direction',undefined,'powerpoint')
    expect(result.slideBuilds?.[2]).toMatchObject({kind:'native-frames',durationMs:500})
    const frame=execFileSync('unzip',['-p',result.nativeFrameSources![0].sourcePath,'ppt/slides/_cuedeck_frame_1.xml'],{encoding:'utf8'})
    const target=frame.match(/<p:pic>[\s\S]*?<\/p:pic>/)![0]
    const y=Number(target.match(/<a:off[^>]*y="(\d+)"/)![1]), h=Number(target.match(/<a:ext[^>]*cy="(\d+)"/)![1])
    expect(y).toBeGreaterThan(685800)
    expect(y+h).toBe(685800+1371600)
    expect(target).toContain('t="93333"')
    expect(target).toContain('b="0"')
  } finally {await rm(dir,{recursive:true,force:true})}
})
