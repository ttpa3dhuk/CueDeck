interface GifDecoder {
  tracks: {ready: Promise<void>; selectedTrack: {frameCount: number; repetitionCount: number} | null}
  decode(options: {frameIndex: number}): Promise<{image: VideoFrame}>
  close(): void
}
type GifDecoderConstructor = new (options: {data: Uint8Array; type: string; preferAnimation: boolean}) => GifDecoder

export function gifDecoder(): GifDecoderConstructor | undefined {
  return (globalThis as unknown as {ImageDecoder?: GifDecoderConstructor}).ImageDecoder
}

/** One decoded frame at a time. ImageDecoder applies GIF disposal/compositing. */
export class GifPlayer {
  private decoder: GifDecoder | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private pixels: ImageData | null = null
  ready = false

  constructor(readonly canvas: HTMLCanvasElement) {}

  async start(bytes: Uint8Array): Promise<void> {
    if (this.stopped) return
    const Decoder = gifDecoder()
    if (!Decoder) throw new Error('GIF ImageDecoder unavailable')
    const decoder = new Decoder({data: bytes, type: 'image/gif', preferAnimation: true})
    this.decoder = decoder
    await decoder.tracks.ready
    if (this.stopped) return
    const track = decoder.tracks.selectedTrack
    if (!track || track.frameCount < 1) throw new Error('GIF track unavailable')
    let index = 0, repeats = 0, deadline = performance.now()
    const tick = async (): Promise<void> => {
      if (this.stopped) return
      const {image} = await decoder.decode({frameIndex: index})
      let duration: number
      try {
        if (this.stopped) return
        if (this.canvas.width !== image.displayWidth || this.canvas.height !== image.displayHeight) {
          this.canvas.width = image.displayWidth; this.canvas.height = image.displayHeight
        }
        if (!this.pixels || this.pixels.width !== image.displayWidth || this.pixels.height !== image.displayHeight)
          this.pixels = new ImageData(image.displayWidth, image.displayHeight)
        const pixels = this.pixels
        // drawImage(VideoFrame) creates a new compositor image-cache key on every
        // decode, including every loop. Copy into one reusable CPU surface instead.
        await image.copyTo(pixels.data, {format: 'RGBA', layout: [{offset: 0, stride: image.displayWidth * 4}]})
        if (this.stopped) return
        this.canvas.getContext('2d', {willReadFrequently: true})!.putImageData(pixels, 0, 0)
        this.ready = true
        this.canvas.dataset.gifFrame = String(index)
        // Match Chromium's GIF convention for missing/sub-20ms delays.
        duration = image.duration == null || image.duration < 20000 ? 100 : image.duration / 1000
      } finally { image.close() }
      index++
      if (index === track.frameCount) {
        index = 0
        if (repeats++ >= track.repetitionCount) return
      }
      deadline += duration
      this.timer = setTimeout(() => { void tick().catch(error => {
        if (!this.stopped) { this.stop(); this.canvas.dataset.failed = '1'; window.api.diag.log('warn', `PPTX GIF decode failed: ${String(error)}`) }
      }) }, Math.max(0, deadline - performance.now()))
    }
    await tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.decoder?.close()
    this.decoder = null
    this.pixels = null
    this.canvas.width = 0; this.canvas.height = 0
  }
}
