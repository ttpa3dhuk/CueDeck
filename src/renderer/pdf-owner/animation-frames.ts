import { paintSprite } from '../shared/animation-compositor'
import type { AnimationComposition } from '../../shared/pdf-frames'
import { PdfLoader } from '../shared/animation-frame-loader'
import { renderForegroundPair } from '../shared/animation-foreground'
import type { AnimationAsset, AnimationRegion } from '../../shared/pdf-frames'

const budget = 48 * 1024 * 1024
const documents = new Map<string, Promise<PdfLoader>>()
const frames = new Map<string, Uint8Array>()
const pending = new Map<string, Promise<Uint8Array>>()
let generation = 0
let current = '',
  currentRevision = '',
  resident = 0
export const animationStats = { rendered: 0, reused: 0, joined: 0, composed: 0, compositionHits: 0 }

export function clearAnimations(keep?: string | null, revision?: string | null) {
  const nextRevision = revision ?? ''
  if (keep && current === keep && currentRevision === nextRevision) return
  generation++
  for (const doc of documents.values()) void doc.then((loader) => loader.dispose()).catch(() => {})
  clearCompositions()
  current = keep ?? ''
  currentRevision = nextRevision
  documents.clear()
  pending.clear()
  frames.clear()
  resident = 0
}

export async function animationFrame(asset: AnimationAsset, region?: AnimationRegion) {
  if (current !== asset.sha) {
    clearAnimations(asset.sha)
  }
  const revision = generation
  let doc = documents.get(asset.file)
  if (!doc) {
    const load = async () => {
      const bytes = await window.pdfOwner.animationBytes(asset.file, asset.sha)
      if (!bytes || revision !== generation) throw new Error('Animation asset retired')
      const loader = new PdfLoader()
      if (!(await loader.loadDocument(bytes))) throw new Error('Animation PDF unavailable')
      if (revision !== generation) { await loader.dispose(); throw new Error('Animation asset retired') }
      return loader
    }
    doc = load()
    documents.set(asset.file, doc)
    void doc.catch(() => {
      if (documents.get(asset.file) === doc) documents.delete(asset.file)
    })
  }
  const loader = await doc
  if (revision !== generation) throw new Error('Animation asset retired')
  if (!region) {
    const page = await loader.getDocument()!.getPage(1)
    const { width, height } = page.getViewport({ scale: 1 })
    return { width, height, pages: loader.totalPages() }
  }
  const { page, width, alpha, rect } = region
  const key = JSON.stringify([asset.file, page, width, alpha, rect.x, rect.y, rect.w, rect.h])
  const hit = frames.get(key)
  if (hit) {
    frames.delete(key)
    frames.set(key, hit)
    animationStats.reused++
    return hit
  }
  const existing = pending.get(key)
  if (existing) {
    animationStats.joined++
    return existing
  }
  const draw = async () => {
    const targetWidth = width / Math.min(window.devicePixelRatio || 1, 2)
    const canvas = alpha
      ? await renderForegroundPair(loader, page, targetWidth, new AbortController().signal, rect)
      : await loader.renderRegion(page, rect, targetWidth)
    if (!canvas) throw new Error('Animation frame unavailable')
    try {
      const bytes = await pngBytes(canvas)
      if (documents.get(asset.file) !== doc) throw new Error('Animation document retired')
      animationStats.rendered++
      frames.set(key, bytes)
      resident += bytes.byteLength
      while (resident > budget && frames.size) {
        const first = frames.keys().next().value!
        resident -= frames.get(first)!.byteLength
        frames.delete(first)
      }
      return bytes
    } finally {
      canvas.width = canvas.height = 0
    }
  }
  const job = draw()
  pending.set(key, job)
  try {
    return await job
  } finally {
    if (pending.get(key) === job) pending.delete(key)
  }
}

const decoded = new Map<string, { image: ImageBitmap; bytes: number }>()
let decodedBytes = 0
const compositions = new Map<string, Promise<Uint8Array>>()
let compositionTail = Promise.resolve()
function clearCompositions() {
  for (const { image } of decoded.values()) image.close()
  decoded.clear()
  decodedBytes = 0
  compositions.clear()
}
async function compose(asset: AnimationAsset, scene: AnimationComposition) {
  const canvas = document.createElement('canvas')
  canvas.width = scene.width
  canvas.height = scene.height
  const ctx = canvas.getContext('2d')!
  try {
    for (const item of scene.sprites) {
      const { page, width, alpha, rect } = item.region
      const key = JSON.stringify([asset.file, page, width, alpha, rect.x, rect.y, rect.w, rect.h])
      let cached = decoded.get(key)
      if (!cached) {
        const bytes = frames.get(key) ?? ((await animationFrame(asset, item.region)) as Uint8Array)
        const image = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
        if (asset.sha !== current) {
          image.close()
          throw new Error('Animation retired')
        }
        cached = { image, bytes: image.width * image.height * 4 }
        decodedBytes += cached.bytes
      }
      decoded.delete(key)
      decoded.set(key, cached)
      paintSprite(ctx, cached.image, item)
      while (decodedBytes > 64 * 1024 * 1024 && decoded.size > 1) {
        const oldest = decoded.keys().next().value!,
          entry = decoded.get(oldest)!
        entry.image.close()
        decodedBytes -= entry.bytes
        decoded.delete(oldest)
      }
    }
    animationStats.composed++
    return await pngBytes(canvas)
  } finally {
    canvas.width = canvas.height = 0
  }
}
export function composeFrame(asset: AnimationAsset, scene: AnimationComposition) {
  const key = JSON.stringify([asset, scene])
  const existing = compositions.get(key)
  if (existing) {
    animationStats.compositionHits++
    return existing
  }
  // Open on receipt so a queued request cannot revive a retired deck.
  const ready = animationFrame(asset)
  const revision = generation
  const job = Promise.all([compositionTail, ready]).then(() => {
    if (revision !== generation) throw new Error('Animation retired')
    return compose(asset, scene)
  })
  compositionTail = job.then(
    () => {},
    () => {},
  )
  compositions.set(key, job)
  if (compositions.size > 12) compositions.delete(compositions.keys().next().value!)
  void job.catch(() => {
    if (compositions.get(key) === job) compositions.delete(key)
  })
  return job
}
async function pngBytes(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Frame encoding failed'))), 'image/png'),
  )
  return new Uint8Array(await blob.arrayBuffer())
}
