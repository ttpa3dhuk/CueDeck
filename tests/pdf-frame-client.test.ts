import { afterEach, expect, it, vi } from 'vitest'
const pending = vi.hoisted(() => ({ requests: [] as { key: any; deliver: boolean }[], defer: false, finish: null as (() => void) | null }))
vi.mock('../packages/render-core/src/frame-port', () => ({
  FramePortClient: class {
    documents = [{ id: 'doc', pages: 10 }]
    constructor(_port: unknown, private paint: (buffer: ArrayBuffer, key: any) => void) {}
    request(key: any, _priority: string, deliver: boolean) {
      pending.requests.push({ key, deliver })
      const draw = () => { if (deliver) this.paint(new ArrayBuffer(key.width * key.height * 4), key); return true }
      return pending.defer ? new Promise<boolean>(resolve => { pending.finish = () => resolve(draw()) }) : Promise.resolve(draw())
    }
    cancel() {}
    close() {}
  },
}))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); pending.requests.length = 0; pending.defer = false; pending.finish = null })
async function setup() {
  const listeners = new Map<string, (event: any) => void>()
  const win = { devicePixelRatio: 2, addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback),
    api: { pdfFrames: {
      describe: async () => ({ id: 'doc', pages: 10, width: 1920, height: 1080, raster: { width: 1920, height: 1080 } }),
      connect: async (requestId: string) => { listeners.get('message')!({ source: win, data: { type: 'cuedeck-pdf-port', metadata: { requestId } }, ports: [{}] }) },
    } } }
  vi.stubGlobal('window', win)
  vi.stubGlobal('getComputedStyle', () => ({ borderRightWidth: '0', borderBottomWidth: '0' }))
  vi.stubGlobal('ImageData', class { constructor(..._args: unknown[]) {} })
  const { PdfLoader } = await import('../src/renderer/shared/pdf-frame-client')
  const loader = new PdfLoader()
  await loader.loadDocument({ url: 'cuedeck-media://pdf-source/doc', size: 1, shared: { id: 'doc' } })
  return loader
}
function canvas(width: number, height: number) {
  const box = { left: 0, top: 0, width, height }
  const paint = vi.fn()
  const target = { width: 0, height: 0, style: {} as Record<string, string>,
    parentElement: { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => box },
    getContext: () => ({ putImageData: paint }) }
  return { target: target as unknown as HTMLCanvasElement, box, paint }
}
it('requests the same PGM/Next raster across card sizes and DPR; resize never requests another PDF size', async () => {
  const loader = await setup(), pgm = canvas(800, 628), next = canvas(300, 200)
  await loader.renderPageTo(2, pgm.target, 800, 628)
  await loader.renderPageTo(2, next.target, 300, 200)
  pgm.box.width = 792
  await loader.renderPageTo(2, pgm.target, 792, 628)
  expect(pending.requests.map(r => r.key)).toEqual(Array(3).fill({ document: 'doc', page: 2, width: 1920, height: 1080, rotation: 0 }))
  expect(pgm.target.style.width).toBe('792px')
  expect(pgm.target.style.height).toBe('445.5px')
  expect(next.target.style.width).toBe('300px')
})
it('fits at paint time after a layout change while the frame was in flight', async () => {
  const loader = await setup(), pgm = canvas(800, 628)
  pending.defer = true
  const request = loader.renderPageTo(2, pgm.target, 800, 628)
  for (let i = 0; i < 30 && !pending.finish; i++) await Promise.resolve()
  expect(pending.finish).not.toBeNull()
  pgm.box.width = 600
  pending.finish!(); await request
  expect(pgm.target.style.width).toBe('600px')
  expect(pgm.target.style.height).toBe('337.5px')
  expect(pgm.paint).toHaveBeenCalledOnce()
})
