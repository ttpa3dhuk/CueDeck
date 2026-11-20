import type { AppState, Role } from './types'

type ProgramOutputs = Pick<AppState, 'stream' | 'omt'> & Partial<Pick<AppState, 'ndi'>>

export function programAudioCaptured(s: ProgramOutputs): boolean {
  return Boolean(s.stream?.running) || (s.omt?.outputs?.program?.state === 'on' && s.omt.programAudio)
    || (s.ndi?.outputs?.program?.state === 'on' && s.ndi.programAudio)
}

export function programVideoOwner(s: ProgramOutputs & Pick<AppState, 'layout'>): Role {
  return s.layout === 'solo' && !programAudioCaptured(s) ? 'operator' : 'audience'
}

/** Canonical identity of the active file-backed program video. */
export function programVideoSource(s: Pick<AppState, 'pdfSha1' | 'fileKind' | 'slideMedia' | 'currentSlide'>): string | null {
  if (!s.pdfSha1) return null
  if (s.fileKind === 'video') return `cuedeck-media://stream/program?v=${encodeURIComponent(s.pdfSha1)}`
  const media = s.fileKind === 'pptx' ? s.slideMedia.find(m => m.slide === s.currentSlide && m.kind === undefined) : null
  return media ? `cuedeck-media://stream/slide/program/${encodeURIComponent(media.file)}?v=${encodeURIComponent(s.pdfSha1)}` : null
}
