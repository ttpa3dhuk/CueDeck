/**
 * Lightweight page counter: counts "/Type /Page" objects, excluding /Pages.
 * Good enough for the header counter; pdf.js in the renderer authoritatively
 * renders and corrects the total via `pdf:report-total`.
 *
 * Known limitation: PDFs with object streams (PDF 1.5+) keep page objects
 * compressed, so the scan finds nothing and returns 0 — the renderer fixes
 * the count after the first render.
 */
export function countPdfPages(buf: Buffer): number {
  const text = buf.toString('latin1')
  const matches = text.match(/\/Type\s*\/Page(?!s)/g)
  return matches ? matches.length : 0
}
