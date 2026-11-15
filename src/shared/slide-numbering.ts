/** PDF page indices stay internal; labels identify the original PPTX slide and click step. */
export interface SlideNumbering {
  total: number
  pages: string[]
}

interface NumberedDeck {
  currentSlide: number
  totalSlides: number
  slideNumbering?: SlideNumbering
}

export function validSlideNumbering(value: unknown, pageCount: number): value is SlideNumbering {
  if (!value || typeof value !== 'object') return false
  const n = value as SlideNumbering
  return Number.isInteger(n.total) && n.total > 0 && Array.isArray(n.pages) &&
    n.pages.length === pageCount && n.pages.every(label => typeof label === 'string' &&
      /^[1-9]\d*(?:\.[1-9]\d*)?$/.test(label) && Number(label.split('.')[0]) <= n.total) &&
    new Set(n.pages).size === n.pages.length
}

export function slidePosition(deck: NumberedDeck): { label: string; total: number; remaining: number } {
  const numbering = validSlideNumbering(deck.slideNumbering, deck.totalSlides) ? deck.slideNumbering : undefined
  const label = numbering?.pages[deck.currentSlide - 1] ?? String(deck.currentSlide)
  const total = numbering?.total ?? deck.totalSlides
  return { label, total, remaining: Math.max(0, total - Number(label.split('.')[0])) }
}

/** Keep the input a string: step 3.10 is distinct from step 3.1. */
export function pageForSlideLabel(input: string, deck: NumberedDeck): number | null {
  const label = input.trim()
  if (!/^[1-9]\d*(?:\.[1-9]\d*)?$/.test(label)) return null
  if (validSlideNumbering(deck.slideNumbering, deck.totalSlides)) {
    const index = deck.slideNumbering.pages.indexOf(label)
    return index < 0 ? null : index + 1
  }
  const page = Number(label)
  return Number.isInteger(page) && page <= deck.totalSlides ? page : null
}
