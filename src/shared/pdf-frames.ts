import type { PdfFileSource } from './pdf-source'
export interface SharedPdfSource { id: string; file: PdfFileSource }
export interface SharedPdfInfo { id: string; pages: number; width?: number; height?: number; raster?: { width: number; height: number } }
export interface AnimationAsset { sha: string; file: string }
export interface AnimationRegion { page: number; width: number; rect: { x: number; y: number; w: number; h: number }; alpha: boolean }
export interface AnimationInfo { pages: number; width: number; height: number }
export type PdfOwnerRequest =
  | { type: 'compose'; asset: AnimationAsset; scene: AnimationComposition }
  | { type: 'animation'; asset: AnimationAsset; region?: AnimationRegion }
  | { type: 'sync'; sources: SharedPdfSource[]; animationSha?: string | null; animationRevision?: string | null }
  | { type: 'describe'; id: string; page?: number }
  | { type: 'detach'; id: string }
  | { type: 'stats' }
export type PdfOwnerCommand = PdfOwnerRequest & { seq: number }
export interface PdfOwnerReply { seq: number; ok: boolean; value?: unknown; error?: string }
export interface PdfFramesApi {
  connect(requestId: string, clientId: string): Promise<void>
  describe(id: string, page?: number): Promise<SharedPdfInfo>
  stats(): Promise<unknown>
}

export interface AnimationSprite {
  region: AnimationRegion
  opacity: number
  transform: number[]
  destination: number[]
}
export interface AnimationComposition {
  width: number
  height: number
  sprites: AnimationSprite[]
}
