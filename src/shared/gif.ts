/** Count GIF image descriptors without mistaking compressed bytes for markers. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13 || !['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) return false
  let pos = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0)
  let frames = 0
  const blocks = (): boolean => {
    while (pos < bytes.length) {
      const size = bytes[pos++]
      if (!size) return true
      pos += size
    }
    return false
  }
  while (pos < bytes.length) {
    const marker = bytes[pos++]
    if (marker === 0x3b) return frames > 1
    if (marker === 0x21) { pos++; if (!blocks()) return false; continue }
    if (marker !== 0x2c || pos + 9 > bytes.length) return false
    const packed = bytes[pos + 8]
    pos += 9 + ((packed & 128) ? 3 * (1 << ((packed & 7) + 1)) : 0)
    pos++ // LZW minimum code size
    if (!blocks()) return false
    frames++
  }
  return false
}
