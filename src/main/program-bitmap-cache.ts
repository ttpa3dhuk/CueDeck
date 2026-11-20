import type { NativeImage } from 'electron'

interface Entry {
  image: NativeImage
  requestedWidth: number
  requestedHeight: number
  width: number
  height: number
  bitmap: Buffer
}

// Program only: NDI and OMT may select the same NativeImage at the same size.
// Three entries, 64 MiB total. The cache never owns an unbounded run of 4K frames.
const entries: Entry[] = []
const MAX_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 3
let bytes = 0

export function clearProgramBitmapCache(): void {
  entries.length = 0
  bytes = 0
}

export function programBitmap(image: NativeImage, width: number, height: number):
  { width: number; height: number; bitmap: Buffer } {
  const hit = entries.findIndex(entry => entry.image === image &&
    entry.requestedWidth === width && entry.requestedHeight === height)
  if (hit >= 0) {
    const [entry] = entries.splice(hit, 1)
    entries.push(entry)
    return entry
  }
  const source = image.getSize()
  const sized = source.width === width && source.height === height
    ? image : image.resize({ width, height, quality: 'good' })
  const actual = sized.getSize()
  const bitmap = sized.toBitmap()
  const result = { width: actual.width, height: actual.height, bitmap }
  // A too-large frame is still returned, but never retained by this cache.
  if (bitmap.length <= MAX_BYTES) {
    entries.push({ image, requestedWidth: width, requestedHeight: height, ...result })
    bytes += bitmap.length
    while (entries.length > MAX_ENTRIES || bytes > MAX_BYTES)
      bytes -= entries.shift()!.bitmap.length
  }
  return result
}
