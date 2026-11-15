import { describe, expect, it } from 'vitest'
import { pageForSlideLabel, slidePosition } from '../src/shared/slide-numbering'

describe('source slide numbering', () => {
  const deck = { currentSlide: 5, totalSlides: 5, slideNumbering: { total: 3, pages: ['1', '2', '3', '3.1', '3.2'] } }
  it('counts three source slides, not five rendered pages', () => {
    expect(slidePosition(deck)).toEqual({ label: '3.2', total: 3, remaining: 0 })
    expect(slidePosition({ ...deck, currentSlide: 2 })).toEqual({ label: '2', total: 3, remaining: 1 })
  })
  it('resolves original numbers after earlier animations and preserves step 10', () => {
    const expanded = { currentSlide: 1, totalSlides: 13, slideNumbering: {
      total: 3, pages: ['1', ...Array.from({ length: 10 }, (_, i) => `1.${i + 1}`), '2', '3'],
    } }
    expect(pageForSlideLabel('3', expanded)).toBe(13)
    expect(pageForSlideLabel('1.10', expanded)).toBe(11)
    expect(pageForSlideLabel('1.1', expanded)).toBe(2)
    expect(pageForSlideLabel('1.11', expanded)).toBeNull()
    expect(pageForSlideLabel('1e1', expanded)).toBeNull()
  })
  it('does not renumber hidden slides or jump to a hidden page', () => {
    const hidden = { currentSlide: 2, totalSlides: 2, slideNumbering: { total: 3, pages: ['1', '3'] } }
    expect(pageForSlideLabel('2', hidden)).toBeNull()
    expect(pageForSlideLabel('3', hidden)).toBe(2)
  })
  it('uses plain page numbers for PDFs and mismatched metadata', () => {
    const pdf = { currentSlide: 2, totalSlides: 5 }
    expect(slidePosition(pdf)).toEqual({ label: '2', total: 5, remaining: 3 })
    expect(pageForSlideLabel('3.1', pdf)).toBeNull()
    expect(pageForSlideLabel('6', pdf)).toBeNull()
    expect(slidePosition({ ...deck, totalSlides: 6 })).toEqual({ label: '5', total: 6, remaining: 1 })
  })
})
