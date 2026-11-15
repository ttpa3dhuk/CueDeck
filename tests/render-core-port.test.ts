import { MessageChannel } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { FramePortServer, FramePortClient, type FramePort } from '../packages/render-core/src/frame-port'
import { RenderKernel } from '../packages/render-core/src/kernel'

const key = (page = 1) => ({ document: 'a', page, width: 2, height: 2, rotation: 0 as const })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const waitFor = async (test: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (test()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Port test timeout')
}
function setup(budget = 64, timeout = 5000, cacheBytes = 128 * 1024 * 1024) {
  const render = vi.fn(async () => ({ byteLength: 16, close: vi.fn() }))
  const kernel = new RenderKernel({ info: { apiVersion: 1, id: 'test-backend', formats: ['rgba8'] },
    describe: async id => ({ id, pages: 10 }), render, async dispose() {} }, { cacheBytes })
  const buffers: ArrayBuffer[] = []
  const server = new FramePortServer(() => { const buffer = new ArrayBuffer(16); buffers.push(buffer); return buffer }, budget, timeout)
  const generation = server.pause()
  server.resume(kernel, [{ id: 'a', pages: 10 }], generation)
  const clients: FramePortClient[] = []
  function connect(id: string, delayAck = false) {
    const { port1, port2 } = new MessageChannel()
    const held: { value: any; transfer?: ArrayBuffer[] }[] = []
    const peer = port2 as unknown as FramePort
    const port: FramePort = { onmessage: null, onmessageerror: null,
      postMessage(value: any, transfer) {
        if (delayAck && value.type === 'ack') held.push({ value, transfer })
        else peer.postMessage(value, transfer)
      },
      start() { peer.onmessage = event => port.onmessage?.(event); peer.start() },
      close() { peer.close() },
    }
    const paint = vi.fn()
    const client = new FramePortClient(port, paint)
    clients.push(client)
    server.attach(id, port1 as unknown as FramePort)
    return { client, paint, flush: () => { delayAck = false; for (const item of held.splice(0)) peer.postMessage(item.value, item.transfer) } }
  }
  cleanups.push(async () => { clients.forEach(client => client.close()); server.close(); await kernel.stop() })
  return { server, kernel, render, buffers, connect }
}

it('transfers actual buffers across MessagePorts and ACK detaches receiver ownership', async () => {
  const { server, render, connect, buffers } = setup()
  const { client, paint } = connect('one')
  await waitFor(() => !!client.documents.length)
  expect(await client.request(key(), 'program')).toBe(true)
  await waitFor(() => server.stats.acknowledged === 1)
  expect(render).toHaveBeenCalledOnce()
  expect(paint).toHaveBeenCalledOnce()
  expect(buffers[0].byteLength).toBe(0)
  expect(paint.mock.calls[0][0].byteLength).toBe(0)
  expect(server.inFlightBytes).toBe(0)
})

it('shares a cached raster between independent clients', async () => {
  const { render, connect } = setup()
  const one = connect('one'), two = connect('two')
  await waitFor(() => !!one.client.documents.length && !!two.client.documents.length)
  await Promise.all([one.client.request(key(), 'program'), two.client.request(key(), 'preview')])
  expect(render).toHaveBeenCalledOnce()
  expect(one.paint).toHaveBeenCalledOnce(); expect(two.paint).toHaveBeenCalledOnce()
})

it('reclaims speculative Next pins under cache pressure and paints without a client error', async () => {
  const { server, kernel, render, connect } = setup(64, 5000, 32)
  const next = connect('next'), stale = connect('stale-next'), pgm = connect('pgm')
  await waitFor(() => [next, stale, pgm].every(c => c.client.documents.length > 0))
  await next.client.request(key(1), 'prefetch', false, true)
  await stale.client.request(key(2), 'preview', true, true)
  expect(kernel.residentBytes).toBe(32)
  expect(await pgm.client.request(key(3), 'program')).toBe(true)
  expect(pgm.paint).toHaveBeenCalledOnce()
  expect(server.stats.pressureReclaims).toBe(1)
  expect(kernel.residentBytes).toBeLessThanOrEqual(32)
  expect(render).toHaveBeenCalledTimes(3)
  // A dropped cache hint does not invalidate the receiver's displayed pixels.
  expect(await stale.client.request(key(4), 'preview', true, true)).toBe(true)
})

it('keeps at most one transfer for a slow receiver and serves another', async () => {
  const { server, connect } = setup()
  const slow = connect('slow', true), pgm = connect('pgm')
  await waitFor(() => !!slow.client.documents.length && !!pgm.client.documents.length)
  await slow.client.request(key(), 'preview')
  const old = slow.client.request(key(2), 'preview')
  const latest = slow.client.request(key(3), 'preview')
  expect(await old).toBe(false)
  expect(await pgm.client.request(key(2), 'program')).toBe(true)
  expect(slow.paint).toHaveBeenCalledTimes(1)
  slow.flush()
  expect(await latest).toBe(true)
  await waitFor(() => server.inFlightBytes === 0)
  expect(slow.paint).toHaveBeenCalledTimes(2)
})

it('waits for budget instead of accumulating transferred allocations', async () => {
  const { server, connect } = setup(16)
  const slow = connect('slow', true), other = connect('other')
  await waitFor(() => !!slow.client.documents.length && !!other.client.documents.length)
  await slow.client.request(key(), 'preview')
  const next = other.client.request(key(2), 'program')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(other.paint).not.toHaveBeenCalled()
  expect(server.stats.peakBytes).toBe(16)
  slow.flush(); expect(await next).toBe(true)
})

it('reclaims transfer accounting when a client closes without ACK', async () => {
  const { server, connect } = setup(16)
  const slow = connect('slow', true)
  await waitFor(() => !!slow.client.documents.length)
  await slow.client.request(key(), 'preview')
  expect(server.inFlightBytes).toBe(16)
  slow.client.close()
  await waitFor(() => server.inFlightBytes === 0)
})

it('disconnects an unacknowledging peer and rejects its waiting request', async () => {
  const { server, connect } = setup(16, 25)
  const slow = connect('slow', true)
  await waitFor(() => !!slow.client.documents.length)
  await slow.client.request(key(), 'preview')
  await expect(slow.client.request(key(2), 'preview')).rejects.toThrow('timed out')
  expect(server.inFlightBytes).toBe(0)
})

it('invalidates requests and accepts a new backend generation', async () => {
  const { server, kernel, connect } = setup()
  const { client } = connect('one', true)
  await waitFor(() => !!client.documents.length)
  await client.request(key(), 'program')
  const waiting = client.request(key(2), 'program')
  const generation = server.pause()
  expect(await waiting).toBe(false)
  await waitFor(() => client.generation === generation)
  server.resume(kernel, [{ id: 'a', pages: 10 }], generation)
  expect(() => server.resume(kernel, [], generation - 1)).toThrow('Stale')
})

it('rejects a frame larger than the delivery budget before allocating', async () => {
  const { server, connect } = setup(8)
  const { client } = connect('one')
  await waitFor(() => !!client.documents.length)
  await expect(client.request(key(), 'program')).rejects.toThrow('budget')
  expect(server.inFlightBytes).toBe(0)
})

it('rejects a missing owner response instead of holding the UI promise forever', async () => {
  const { port1, port2 } = new MessageChannel()
  const client = new FramePortClient(port1 as unknown as FramePort, () => {}, 10)
  try { await expect(client.request(key(), 'program')).rejects.toThrow('did not respond') }
  finally { client.close(); port2.close() }
})

it('returns the transfer even when drawing fails', async () => {
  const { server } = setup()
  const { port1, port2 } = new MessageChannel()
  const client = new FramePortClient(port2 as unknown as FramePort, () => { throw new Error('canvas failed') })
  server.attach('bad-canvas', port1 as unknown as FramePort)
  try {
    await waitFor(() => !!client.documents.length)
    await expect(client.request(key(), 'program')).rejects.toThrow('canvas failed')
    await waitFor(() => server.inFlightBytes === 0)
  } finally { client.close() }
})

it('settles and closes when the acknowledgement transport throws', async () => {
  const fake: FramePort = { onmessage: null, onmessageerror: null, start() {}, close: vi.fn(),
    postMessage(message: any) { if (message.type === 'ack') throw new Error('peer gone') } }
  const client = new FramePortClient(fake, () => {})
  const request = client.request(key(), 'program')
  fake.onmessage!({ data: { type: 'frame', generation: 0, seq: 1, delivery: 1, key: key(), buffer: new ArrayBuffer(16) } })
  await expect(request).rejects.toThrow('acknowledgement failed')
  expect(fake.close).toHaveBeenCalledOnce()
})

it('reattaches a recreated display without reopening its PDF owner', async () => {
  const { server, render, connect } = setup()
  const old = connect('display')
  await waitFor(() => !!old.client.documents.length)
  await old.client.request(key(), 'program')
  old.client.close()
  await waitFor(() => server.stats.disconnected === 1)
  const recreated = connect('display')
  await waitFor(() => !!recreated.client.documents.length)
  expect(await recreated.client.request(key(), 'program')).toBe(true)
  expect(render).toHaveBeenCalledOnce()
})

it('settles a request to a stopped owner instead of spinning a microtask loop', async () => {
  const { kernel, connect } = setup()
  const { client } = connect('one')
  await waitFor(() => !!client.documents.length)
  await kernel.stop()
  await expect(client.request(key(), 'program')).rejects.toThrow('cancelled by render owner')
})

it('warms the shared raster without transferring or painting prefetch pixels', async () => {
  const { server, render, buffers, connect } = setup()
  const { client, paint } = connect('prefetch')
  await waitFor(() => !!client.documents.length)
  expect(await client.request(key(), 'prefetch', false)).toBe(true)
  expect(server.stats.prepared).toBe(1)
  expect(buffers).toHaveLength(0)
  expect(paint).not.toHaveBeenCalled()
  expect(await client.request(key(), 'program')).toBe(true)
  expect(render).toHaveBeenCalledOnce()
})

it('updating Preview metadata preserves an in-flight Program and its generation', async () => {
  const { server, render, connect } = setup()
  let finish!: (frame: { byteLength: number; close: ReturnType<typeof vi.fn> }) => void
  render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const { client } = connect('program')
  await waitFor(() => !!client.documents.length)
  const generation = client.generation
  const request = client.request(key(), 'program')
  await waitFor(() => render.mock.calls.length > 0)
  server.updateDocuments([{ id: 'a', pages: 10 }, { id: 'b', pages: 5 }])
  finish({ byteLength: 16, close: vi.fn() })
  expect(await request).toBe(true)
  expect(client.generation).toBe(generation)
})

it('pins prepared Next through cache churn and releases it when its document retires', async () => {
  const { server, render, kernel, connect } = setup(64, 5000, 32)
  const next = connect('next'), pgm = connect('pgm')
  await waitFor(() => !!next.client.documents.length && !!pgm.client.documents.length)
  await next.client.request(key(2), 'prefetch', false, true)
  await pgm.client.request(key(3), 'program')
  await pgm.client.request(key(4), 'program')
  const count = render.mock.calls.length
  await pgm.client.request(key(2), 'program')
  expect(render.mock.calls.length).toBe(count)
  kernel.invalidateDocument('a')
  expect(kernel.residentBytes).toBe(16)
  server.updateDocuments([])
  expect(kernel.residentBytes).toBe(0)
})

it('releases prepared Next when the receiver advances or closes', async () => {
  const { kernel, connect } = setup(64, 5000, 32)
  const next = connect('next')
  await waitFor(() => !!next.client.documents.length)
  await next.client.request(key(2), 'preview', true, true)
  await next.client.request(key(3), 'prefetch', false, true)
  kernel.invalidateDocument('a')
  expect(kernel.residentBytes).toBe(16)
  next.client.close()
  await waitFor(() => kernel.residentBytes === 0)
})

it('cancelling a settled pane releases its pinned raster while its deck stays active elsewhere', async () => {
  const { kernel, connect } = setup()
  const next = connect('next')
  await waitFor(() => !!next.client.documents.length)
  await next.client.request(key(2), 'prefetch', false, true)
  kernel.invalidateDocument('a')
  expect(kernel.residentBytes).toBe(16)
  next.client.cancel()
  await waitFor(() => kernel.residentBytes === 0)
})
