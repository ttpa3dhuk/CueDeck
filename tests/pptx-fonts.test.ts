import { describe, expect, it } from 'vitest'
import { normalizeFontName, requestedFonts, substitutedFonts, usedPdfFonts } from '../src/main/pptx-fonts'

const pdfWith = (...fonts: string[]): Buffer =>
  Buffer.from(fonts.map((f, i) => `${i} 0 obj\n<</Type/Font/BaseFont/${f}/Subtype/TrueType>>\nendobj\n`).join(''), 'latin1')

describe('normalizeFontName', () => {
  it('сводит PostScript-имена к семейству', () => {
    expect(normalizeFontName('Arial')).toBe(normalizeFontName('ArialMT'))
    expect(normalizeFontName('Times New Roman')).toBe(normalizeFontName('TimesNewRomanPSMT'))
    expect(normalizeFontName('Calibri')).toBe(normalizeFontName('Calibri-Bold'))
  })
})

describe('usedPdfFonts', () => {
  it('читает BaseFont и срезает префикс подмножества', () => {
    expect(usedPdfFonts(pdfWith('BAAAAA+ArialMT', 'CAAAAA+Carlito'))).toEqual(['ArialMT', 'Carlito'])
  })
})

describe('substitutedFonts', () => {
  it('находит шрифт, вместо которого в PDF другой', () => {
    expect(substitutedFonts(['Aptos', 'Arial'], pdfWith('BAAAAA+ArialUnicodeMS', 'CAAAAA+ArialMT'))).toEqual(['Aptos'])
  })
  it('метрически совместимую замену не считает подменой', () => {
    expect(substitutedFonts(['Calibri', 'Cambria', 'Times New Roman'], pdfWith('Carlito', 'Caladea', 'LiberationSerif'))).toEqual([])
  })
  it('вариант семейства («Aptos Display»), когда в PDF есть само семейство, подменой не считается', () => {
    expect(substitutedFonts(['Aptos', 'Aptos Display'], pdfWith('Aptos', 'ArialMT'))).toEqual([])
  })
  it('а при чужом шрифте в PDF — считается', () => {
    expect(substitutedFonts(['Aptos Display'], pdfWith('ArialUnicodeMS'))).toEqual(['Aptos Display'])
  })
  it('основного начертания нет, а есть только соседние («AptosDisplay», «Aptos-Light»), — подмена', () => {
    expect(substitutedFonts(['Aptos'], pdfWith('AptosDisplay', 'ArialMT'))).toEqual(['Aptos'])
    expect(substitutedFonts(['Aptos'], pdfWith('Aptos-Light'))).toEqual(['Aptos'])
  })
  it('«Futura-Medium» и «Avenir-Book» — это сами Futura и Avenir', () => {
    expect(substitutedFonts(['Futura', 'Avenir'], pdfWith('Futura-Medium', 'Avenir-Book'))).toEqual([])
  })
  it('нет шрифтов в PDF — проверять нечем, молчим', () => {
    expect(substitutedFonts(['Gotham'], Buffer.from('%PDF-1.7 без шрифтов'))).toEqual([])
  })
})

describe('requestedFonts', () => {
  const run = (t: string, face?: string): string =>
    `<a:r><a:rPr>${face ? `<a:latin typeface="${face}"/>` : ''}</a:rPr><a:t>${t}</a:t></a:r>`
  const files: Record<string, string> = {
    'ppt/slides/slide1.xml':
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' + run('Заголовок') + '</p:sp>' +
      '<p:sp>' + run('Текст', 'Gotham Pro') + run('Без шрифта') + run('   ', 'Пустой Шрифт') + run('•', 'Wingdings') + '</p:sp>',
    'ppt/slideMasters/slideMaster1.xml': '<p:titleStyle><a:lvl1pPr><a:defRPr><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': '<Relationship Target="../theme/theme1.xml"/>',
    'ppt/theme/theme1.xml':
      '<a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont>',
  }
  it('берёт шрифты напечатанного текста: явные и унаследованные от темы', () => {
    const got = requestedFonts(Object.keys(files), (n) => files[n] ?? null, ['ppt/slides/slide1.xml'])
    expect(got).toEqual(['Aptos', 'Aptos Display', 'Gotham Pro'])
  })
  it('шрифт, который есть только в теме, а в тексте не используется, не считается', () => {
    const only: Record<string, string> = {
      ...files,
      'ppt/slides/slide1.xml': '<p:sp>' + run('Всё Arial', 'Arial') + '</p:sp>',
      'ppt/theme/theme1.xml': '<a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont>',
    }
    expect(requestedFonts(Object.keys(only), (n) => only[n] ?? null, ['ppt/slides/slide1.xml'])).toEqual(['Arial'])
  })
})
