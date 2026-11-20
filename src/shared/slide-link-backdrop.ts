import type { SlideVideoLink } from './types.js'

export const LINK_BACKDROPS_PDF = 'link-backdrops.pdf'

/** Each backdrop page shows the board with its disjoint, self-hiding links removed. */
export function linkBackdropPageCount(links?: Record<number, SlideVideoLink[]>): number {
  let pages = 0
  for (const group of Object.values(links ?? {})) {
    for (const { hideAfterVisit } of group) {
      if (hideAfterVisit === undefined) continue
      if (!hideAfterVisit || !Number.isSafeInteger(hideAfterVisit.page) || hideAfterVisit.page < 1 ||
          typeof hideAfterVisit.shape !== 'string' || !/^\d+$/.test(hideAfterVisit.shape)) {
        throw new Error('Invalid PPTX link backdrop')
      }
      pages = Math.max(pages, hideAfterVisit.page)
    }
  }
  return pages
}

export function activeLinkBackdrop(file: string, links?: SlideVideoLink[]): boolean {
  return file === LINK_BACKDROPS_PDF && Boolean(links?.some(link => link.hideAfterVisit))
}
