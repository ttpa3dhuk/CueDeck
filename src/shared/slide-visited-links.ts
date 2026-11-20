import type { AppState, SlideVideoLink } from './types'

export function isVisitedLink(state: Pick<AppState, 'slideVisitedLinks'>, slide: number, link: SlideVideoLink): boolean {
  return Boolean(link.hideAfterVisit && state.slideVisitedLinks?.[slide]?.includes(link.hideAfterVisit.shape))
}

/** Only linked cells with an authored alternative backdrop participate. */
export function recordLinkedVisit(state: Pick<AppState, 'slideVisitedLinks'>, slide: number, link: SlideVideoLink):
  Pick<AppState, 'slideVisitedLinks'> | null {
  const shape = link.hideAfterVisit?.shape
  if (!shape || isVisitedLink(state, slide, link)) return null
  return { slideVisitedLinks: { ...state.slideVisitedLinks,
    [slide]: [...(state.slideVisitedLinks?.[slide] ?? []), shape] } }
}
