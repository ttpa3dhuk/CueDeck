import { describe, expect, it } from 'vitest'
import { runPptxWork } from '../src/main/pptx-work'

describe('PPTX work while transferring', () => {
  it('waits for preparation and conversion before a live selection uses the same temporary files', async () => {
    const calls: string[] = []
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const transfer = runPptxWork(async () => { calls.push('transfer'); await wait; calls.push('ready') })
    const selection = runPptxWork(async () => { calls.push('selection') })
    await Promise.resolve()
    expect(calls).toEqual(['transfer'])
    release()
    await Promise.all([transfer, selection])
    expect(calls).toEqual(['transfer', 'ready', 'selection'])
  })

  it('does not leave the queue stuck after a failed conversion', async () => {
    await expect(runPptxWork(async () => { throw new Error('failed') })).rejects.toThrow('failed')
    expect(await runPptxWork(async () => 'ready')).toBe('ready')
  })
})
