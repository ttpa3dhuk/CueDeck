/** PDF.js 4.10 predates the upstream Chrome ImageDecoder re-enable:
 * https://github.com/mozilla/pdf.js/pull/20961
 * Keep its defaults outside Chromium. The conservative Chrome floor is the
 * bundled/tested Electron 44.7.2 runtime (Chromium 152), including the old ICC
 * JPEG and oversized BMP regressions. Missing WebCodecs keeps the JS fallback.
 */
export function pdfImageDecoderOption(userAgent: string, available: boolean): boolean | undefined {
  const chromium = /\b(?:Chrome|Chromium)\/(\d+)\./.exec(userAgent)
  if (!chromium) return undefined
  return available && Number(chromium[1]) >= 152
}
