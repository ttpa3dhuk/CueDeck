// Shared VideoFrame -> WebGPU external texture -> display. No media decoder.
const canvas = document.getElementById('frame') as HTMLCanvasElement
const stats = { frames: 0, redraws: 0, lastSerial: 0, errors: 0, adapter: '', width: 0, height: 0 }
;(window as unknown as { gpuViewStats: typeof stats }).gpuViewStats = stats

async function main(): Promise<void> {
  // WebGPU types are not in this project's DOM TypeScript library yet.
  const gpu = (navigator as unknown as { gpu?: any }).gpu
  if (!gpu) throw new Error('WebGPU is unavailable for the audience display')
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU display adapter')
  const info = adapter.info
  stats.adapter = JSON.stringify({ vendor: info?.vendor, architecture: info?.architecture,
    device: info?.device, description: info?.description, isFallbackAdapter: info?.isFallbackAdapter })
  if (info?.isFallbackAdapter || /swiftshader|software/i.test(stats.adapter)) throw new Error('Software WebGPU display adapter is not supported')
  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu' as any) as any
  if (!context) throw new Error('Cannot create the WebGPU display surface')
  const format = gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })
  const module = device.createShaderModule({ code: `
    struct Vertex { @builtin(position) p: vec4f, @location(0) uv: vec2f };
    @vertex fn vs(@builtin(vertex_index) id: u32) -> Vertex {
      var positions = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
      let p=positions[id]; var out:Vertex;
      out.p=vec4f(p,0,1); out.uv=vec2f((p.x+1)/2,(1-p.y)/2); return out;
    }
    @group(0) @binding(0) var image:texture_external;
    @group(0) @binding(1) var filtering:sampler;
    @group(0) @binding(2) var cached:texture_2d<f32>;
    @fragment fn fs(in:Vertex)->@location(0) vec4f {
      return textureSampleBaseClampToEdge(image,filtering,in.uv);
    }
    @fragment fn display(in:Vertex)->@location(0) vec4f {
      return textureSample(cached,filtering,in.uv);
    }` })
  const pipeline = device.createRenderPipeline({
    layout: 'auto', vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  const displayPipeline = device.createRenderPipeline({
    layout: 'auto', vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'display', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  let cached: any = null
  let sourceWidth = 0, sourceHeight = 0
  let displayBindings: any = null
  const report = (error: unknown): void => {
    stats.errors++
    window.api.gpuMirror.ready({ error: String(error) })
  }
  function pass(encoder: any, view: any): any {
    return encoder.beginRenderPass({ colorAttachments: [{ view,
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] })
  }
  function drawDisplay(encoder: any): void {
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio))
    const h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio))
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    const output = pass(encoder, context.getCurrentTexture().createView())
    const scale = Math.min(w / sourceWidth, h / sourceHeight)
    const rw = sourceWidth * scale, rh = sourceHeight * scale
    output.setViewport((w-rw)/2, (h-rh)/2, rw, rh, 0, 1)
    output.setPipeline(displayPipeline); output.setBindGroup(0, displayBindings); output.draw(6); output.end()
    stats.width = w; stats.height = h
  }
  // Keep one private GPU texture so resize can redraw a static slide after its
  // imported VideoFrame has been released. No extra source frame is retained.
  new ResizeObserver(() => {
    if (!cached) return
    try {
      const encoder = device.createCommandEncoder()
      drawDisplay(encoder); device.queue.submit([encoder.finish()]); stats.redraws++
      void device.queue.onSubmittedWorkDone().catch(report)
    } catch (error) { report(error) }
  }).observe(canvas)
  device.addEventListener('uncapturederror', (event: any) => {
    report(event.error?.message ?? event.error)
  })
  void device.lost.then((reason: any) => window.api.gpuMirror.ready({ error: `GPU display device lost: ${reason.message}` }))
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'cuedeck-audience-gpu') return
    const frame = event.data.frame as VideoFrame
    if (!(frame instanceof VideoFrame)) return
    void (async () => {
      try {
        if (!cached || sourceWidth !== frame.displayWidth || sourceHeight !== frame.displayHeight) {
          cached?.destroy()
          sourceWidth = frame.displayWidth; sourceHeight = frame.displayHeight
          // TEXTURE_BINDING | RENDER_ATTACHMENT; this texture is never mapped.
          cached = device.createTexture({ size: [sourceWidth, sourceHeight], format, usage: 4 | 16 })
          displayBindings = device.createBindGroup({ layout: displayPipeline.getBindGroupLayout(0),
            entries: [{ binding: 1, resource: sampler }, { binding: 2, resource: cached.createView() }] })
        }
        const texture = device.importExternalTexture({ source: frame })
        const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: texture }, { binding: 1, resource: sampler }] })
        const encoder = device.createCommandEncoder()
        const capture = pass(encoder, cached.createView())
        capture.setPipeline(pipeline); capture.setBindGroup(0, bindGroup); capture.draw(6); capture.end()
        drawDisplay(encoder)
        device.queue.submit([encoder.finish()])
        await device.queue.onSubmittedWorkDone()
        stats.frames++; stats.lastSerial = event.data.metadata.serial
      } catch (error) {
        report(error)
      } finally { frame.close() }
    })()
  })
  window.api.gpuMirror.ready({ adapter: stats.adapter })
}
void main().catch(error => { stats.errors++; window.api.gpuMirror.ready({ error: String(error) }) })
