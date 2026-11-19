import type {
  AnimationAsset,
  AnimationComposition,
  AnimationRegion,
  AnimationSprite,
} from '../../shared/pdf-frames'

export const spriteSources = new WeakMap<HTMLCanvasElement, { asset: AnimationAsset; region: AnimationRegion }>()
interface Sprite {
  source: HTMLCanvasElement
  opacity: number
  transform: number[]
  destination: number[]
}
export function sprite(
  source: HTMLCanvasElement,
  opacity = 1,
  transform = [1, 0, 0, 1, 0, 0],
  destination = [0, 0, source.width, source.height],
): Sprite {
  return { source, opacity, transform, destination }
}
export function paintSprite(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  item: Pick<Sprite, 'opacity' | 'transform' | 'destination'>,
) {
  const [a, b, c, d, e, f] = item.transform
  const [x, y, w, h] = item.destination
  ctx.setTransform(a, b, c, d, e, f)
  ctx.globalAlpha = item.opacity
  ctx.drawImage(image, x, y, w, h)
}
const live = new WeakMap<HTMLCanvasElement, { key: string; busy: boolean; next?: () => void }>()
export function invalidateComposition(canvas: HTMLCanvasElement) {
  live.delete(canvas)
}

export function paintComposition(canvas: HTMLCanvasElement, width: number, height: number, items: Sprite[]) {
  const first = spriteSources.get(items[0].source)
  const shared = window.api?.pptx?.composeAnimation
  if (!first || !shared) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')!
    ctx.save()
    ctx.clearRect(0, 0, width, height)
    for (const item of items) paintSprite(ctx, item.source, item)
    ctx.restore()
    return
  }
  const sprites: AnimationSprite[] = items.map(({ source, ...item }) => ({
    ...item,
    region: spriteSources.get(source)!.region,
  }))
  const scene: AnimationComposition = { width, height, sprites }
  const key = JSON.stringify([first.asset, scene])
  let state = live.get(canvas)
  if (!state) {
    state = { key: '', busy: false }
    live.set(canvas, state)
  }
  if (state.key === key) {
    state.next = undefined
    return
  }
  if (state.busy) {
    state.next = () => paintComposition(canvas, width, height, items)
    return
  }
  state.key = key
  state.busy = true
  void shared(first.asset, scene)
    .then(async (bytes) => {
      if (live.get(canvas) !== state) return
      const image = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
      try {
        if (live.get(canvas) !== state) return
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        const ctx = canvas.getContext('2d')!
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(image, 0, 0)
      } finally {
        image.close()
      }
    })
    .catch((error) => {
      state.key = ''
      if (live.get(canvas) === state) console.warn('Animation composition unavailable', error)
    })
    .finally(() => {
      state.busy = false
      if (live.get(canvas) === state) {
        const next = state.next
        state.next = undefined
        next?.()
      }
    })
}
