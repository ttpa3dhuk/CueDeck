/** Large PDFs stay on disk; windows request only the byte ranges they need. */
export interface PdfFileSource { url: string; size: number; shared?: { id: string } }
export interface DeckFileData { bytes: Uint8Array; mime: string; pdf?: PdfFileSource }
