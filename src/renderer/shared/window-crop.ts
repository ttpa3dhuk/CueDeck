import { windowCropRect, type WindowCrop } from '../../shared/live'

/** Crop the pixels before presentation so every output and transition sees the same image. */
export async function cropWindowStream(raw: MediaStream, crop: WindowCrop, fps = 30, ceiling = fps): Promise<{ stream: MediaStream; dispose: () => void; setFps: (value: number) => void }> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  video.srcObject = raw
  document.body.append(video)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  let callback = 0
  let disposed = false
  let origin: number | null = null
  let lastSlot = -1
  const draw = (now = performance.now()) => {
    if (disposed) return
    const w = video.videoWidth, h = video.videoHeight
    origin ??= now
    const slot = Math.floor((now - origin + 0.01) * fps / 1000)
    if (w && h && slot > lastSlot) {
      lastSlot = slot
      const rect = windowCropRect(w, h, crop)
      if (canvas.width !== rect.width) canvas.width = rect.width
      if (canvas.height !== rect.height) canvas.height = rect.height
      ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
    }
    callback = video.requestVideoFrameCallback(draw)
  }
  const dispose = () => {
    disposed = true
    video.cancelVideoFrameCallback(callback)
    video.pause()
    video.srcObject = null
    video.remove()
    raw.getTracks().forEach((t) => t.stop())
  }
  try {
    await video.play()
    draw()
    const stream = canvas.captureStream(ceiling)
    return { stream, dispose, setFps: value => { fps = value; origin = null; lastSlot = -1 } }
  } catch (error) {
    dispose()
    throw error
  }
}
