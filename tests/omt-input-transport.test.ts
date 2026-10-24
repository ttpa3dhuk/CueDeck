import { describe, expect, it, vi } from 'vitest'
import { OmtInputTransport } from '../src/main/omt/input-transport'
import type { OmtInputFrame } from '../src/shared/omt-input'
const video = { type: 'video' } as OmtInputFrame, audio = { type: 'audio' } as OmtInputFrame
const first = 'HOST (First)', second = 'HOST (Second)'
describe('direct OMT worker transport', () => {
  it('bounds independent video/audio queues and frees only acknowledged capacity', () => {
    const send = vi.fn(), flow = new OmtInputTransport(send)
    flow.retain([first, second])
    for (let i = 0; i < 30; i++) { flow.frame(first, video); flow.frame(first, audio) }
    expect(send.mock.calls.filter(([p]) => p.frame.type === 'video')).toHaveLength(2)
    expect(send.mock.calls.filter(([p]) => p.frame.type === 'audio')).toHaveLength(24)
    expect(flow.droppedAudio).toBe(6) // 30 sent, 24 unacked window
    expect(flow.droppedVideo).toBe(28) // 2 sent, window of 2
    flow.frame(second, video)
    expect(send).toHaveBeenCalledTimes(27)
    flow.ack(send.mock.calls[0][0].sequence)
    flow.frame(first, video)
    flow.ack(-1); flow.frame(first, video)
    expect(send).toHaveBeenCalledTimes(28)
  })
  it('keeps pending on repeated retain but clears removed sources and close', () => {
    const send = vi.fn(), flow = new OmtInputTransport(send)
    flow.retain([first]); flow.frame(first, video); flow.frame(first, video)
    flow.retain([first]); flow.frame(first, video)
    expect(send).toHaveBeenCalledTimes(2)
    flow.retain([]); flow.frame(first, video)
    flow.retain([first]); flow.frame(first, video)
    expect(send).toHaveBeenCalledTimes(3)
    flow.close(); flow.frame(first, video)
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('does not leak capacity if posting to a closed port throws', () => {
    const send = vi.fn().mockImplementationOnce(() => { throw new Error('closed') }), flow = new OmtInputTransport(send)
    flow.retain([first])
    expect(() => flow.frame(first, video)).toThrow('closed')
    flow.frame(first, video); flow.frame(first, video)
    expect(send).toHaveBeenCalledTimes(3)
  })
})
