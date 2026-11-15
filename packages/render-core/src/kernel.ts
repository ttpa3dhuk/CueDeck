import { SlideFrameSource, type OwnedSlideFrame, type SlideFrameBackend } from './frame-source.js'

/** Host-neutral v1 contract. No Electron, DOM, file paths or PDF.js types. */
export interface RenderBackendInfo {
  apiVersion: 1
  id: string
  formats: readonly ['rgba8']
}
export interface RenderDocumentInfo { id: string; pages: number }
export interface RenderBackend<T extends OwnedSlideFrame> extends SlideFrameBackend<T> {
  readonly info: RenderBackendInfo
  describe(document: string): Promise<RenderDocumentInfo>
}

/** A backend can live in a renderer, worker or external service. The host chooses
 * its implementation and transport; the control panel never receives its internals. */
export class RenderKernel<T extends OwnedSlideFrame> extends SlideFrameSource<T> {
  readonly backendInfo: RenderBackendInfo
  constructor(private renderer: RenderBackend<T>, options: { cacheBytes?: number; maxConsumers?: number } = {}) {
    super(renderer, options.cacheBytes, options.maxConsumers)
    if (renderer.info.apiVersion !== 1 || !renderer.info.formats.includes('rgba8')) throw new Error('Unsupported render backend contract')
    this.backendInfo = renderer.info
  }
  describe(document: string): Promise<RenderDocumentInfo> { return this.renderer.describe(document) }
}
