/** A PowerPoint PDF can have fewer pages than LibreOffice's animation-step PDF. */
export function presentationNotesPath(filePath: string, cacheSha1: string, sourceSha1?: string): string {
  return sourceSha1 && sourceSha1 !== cacheSha1
    ? `${filePath}.powerpoint-steps-v2.pptx`
    : filePath
}
