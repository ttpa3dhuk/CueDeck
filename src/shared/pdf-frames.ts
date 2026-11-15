import type { PdfFileSource } from './pdf-source'
export interface SharedPdfSource { id: string; file: PdfFileSource }
export interface SharedPdfInfo { id: string; pages: number; width?: number; height?: number; raster?: { width: number; height: number } }
export type PdfOwnerRequest =
  | { type: 'sync'; sources: SharedPdfSource[] }
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
