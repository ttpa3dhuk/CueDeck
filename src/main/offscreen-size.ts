/** OSR uses outer DIP size at an explicit 1x scale; correct Windows DPI rounding before loading. */
export function fitOffscreenSize(
  win: { getSize(): number[]; setSize(width: number, height: number): void; destroy(): void },
  width: number,
  height: number,
  label: string,
): void {
  let requestedWidth = width
  let requestedHeight = height
  for (let attempt = 0; attempt < 4; attempt++) {
    const [actualWidth, actualHeight] = win.getSize()
    if (actualWidth === width && actualHeight === height) break
    if (attempt > 0) {
      requestedWidth += width - actualWidth
      requestedHeight += height - actualHeight
    }
    win.setSize(requestedWidth, requestedHeight)
  }
  const [actualWidth, actualHeight] = win.getSize()
  if (actualWidth !== width || actualHeight !== height) {
    win.destroy()
    throw new Error(`${label} window size ${actualWidth}x${actualHeight} does not match target ${width}x${height}`)
  }
}
