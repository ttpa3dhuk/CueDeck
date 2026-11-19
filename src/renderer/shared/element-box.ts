/** Fractional padding box shared by the picture and its transition overlay. */
export function paddingBox(element: HTMLElement): { left: number; top: number; width: number; height: number } {
  const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
  const left = element.clientLeft || 0, top = element.clientTop || 0
  return {
    left: rect.left + left, top: rect.top + top,
    width: rect.width - left - (Number.parseFloat(style.borderRightWidth) || left),
    height: rect.height - top - (Number.parseFloat(style.borderBottomWidth) || top),
  }
}

export type ContentBox = Pick<DOMRect, 'left' | 'top' | 'width' | 'height' | 'right' | 'bottom'>

/** The authored slide occupies this box inside an object-fit:contain canvas. */
export function containedBox(box: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, width: number, height: number): ContentBox {
  const scale = width > 0 && height > 0 ? Math.min(box.width / width, box.height / height) : 0
  const w = scale > 0 ? width * scale : box.width, h = scale > 0 ? height * scale : box.height
  const left = box.left + (box.width - w) / 2, top = box.top + (box.height - h) / 2
  return {left, top, width: w, height: h, right: left + w, bottom: top + h}
}

export function canvasContentBox(canvas: HTMLCanvasElement): ContentBox {
  const box = canvas.getBoundingClientRect()
  return getComputedStyle(canvas).objectFit === 'contain' ? containedBox(box, canvas.width, canvas.height) : box
}
