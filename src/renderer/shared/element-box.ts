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
