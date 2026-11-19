import { expect, it, vi } from 'vitest'
import { fitOffscreenSize } from '../src/main/offscreen-size'
it('corrects a fractional-DPI round trip and screen-constrained initial bounds', () => {
  let size = [800, 600]
  const win = { getSize: () => size, setSize: vi.fn((w: number, h: number) => { size = [w + 1, h + 1] }), destroy: vi.fn() }
  fitOffscreenSize(win, 1280, 720, 'NDI timer')
  expect(size).toEqual([1280, 720])
  expect(win.setSize).toHaveBeenLastCalledWith(1279, 719)
  expect(win.destroy).not.toHaveBeenCalled()
})
it('destroys an incorrectly sized source instead of publishing it as the selected resolution', () => {
  const win = { getSize: () => [800, 600], setSize: vi.fn(), destroy: vi.fn() }
  expect(() => fitOffscreenSize(win, 1280, 720, 'NDI timer')).toThrow('NDI timer window size 800x600')
  expect(win.setSize).toHaveBeenCalledTimes(4)
  expect(win.destroy).toHaveBeenCalledOnce()
})
