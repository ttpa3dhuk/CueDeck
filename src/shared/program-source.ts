import type { AppState, Role } from './types'

export function programVideoOwner(s: Pick<AppState, 'layout' | 'stream' | 'omt'>): Role {
  const captured = Boolean(s.stream?.running) || (s.omt?.outputs?.program?.state === 'on' && s.omt.programAudio)
  return s.layout === 'solo' && !captured ? 'operator' : 'audience'
}

/** Canonical identity of the active file-backed program video. */
export function programVideoSource(s: Pick<AppState, 'pdfSha1' | 'fileKind' | 'slideMedia' | 'currentSlide'>): string | null {
  if (!s.pdfSha1) return null
  if (s.fileKind === 'video') return `cuedeck-media://stream/program?v=${encodeURIComponent(s.pdfSha1)}`
  const media = s.fileKind === 'pptx' ? s.slideMedia.find(m => m.slide === s.currentSlide && m.kind !== 'gif') : null
  return media ? `cuedeck-media://stream/slide/program/${encodeURIComponent(media.file)}?v=${encodeURIComponent(s.pdfSha1)}` : null
}
