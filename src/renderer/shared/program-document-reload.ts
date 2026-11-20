import type { AppState } from '../../shared/types'

/** A new prepared PDF can replace a PPTX deck without changing its source path or SHA. */
export function shouldReloadProgramDocument(previousPath: string | null, state: Pick<AppState, 'pdfPath' | 'fileKind'>,
  patch: Partial<AppState> | null): boolean {
  return state.pdfPath !== previousPath || Boolean((state.fileKind === 'pdf' || state.fileKind === 'pptx') && patch &&
    (Object.hasOwn(patch, 'slideMedia') || Object.hasOwn(patch, 'pdfSha1')))
}

export function shouldReloadPreviewDocument(previousPath: string | null, previousSha1: string | null,
  preview: Pick<AppState['preview'], 'path' | 'sha1'>): boolean {
  return preview.path !== previousPath || preview.sha1 !== previousSha1
}
