/** Keep HDR/wide-gamut and unknown color pipelines on Chromium's native video surface. */
export function canMirrorColor(color: { primaries?: string | null; transfer?: string | null }): boolean {
  return ['bt709', 'bt470bg', 'smpte170m'].includes(color.primaries ?? '') &&
    ['bt709', 'smpte170m', 'iec61966-2-1'].includes(color.transfer ?? '')
}
