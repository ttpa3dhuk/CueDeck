import { beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const data = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showMessageBox: data.show } }))
import { setLang } from '../src/shared/i18n'
import { attachAudienceCloseGuard } from '../src/main/audience-close-guard'
class Window extends EventEmitter {
  destroyed = false
  isDestroyed() { return this.destroyed }
  close() {
    const event = { preventDefault: vi.fn() }
    this.emit('close', event)
    if (!event.preventDefault.mock.calls.length) this.destroyed = true
  }
}
beforeEach(() => { data.show.mockReset(); setLang('ru') })
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
it('cancel keeps the output open and explains how to reopen it', async () => {
  data.show.mockResolvedValue({ response: 0 })
  const win = new Window()
  attachAudienceCloseGuard(win as any, () => true)
  win.close(); await flush()
  expect(win.destroyed).toBe(false)
  expect(data.show.mock.calls[0][0]).toBe(win)
  expect(data.show.mock.calls[0][1]).toMatchObject({ defaultId: 0, cancelId: 0 })
  expect(data.show.mock.calls[0][1].detail).toContain('Экраны → Режим работы')
})
it('confirmed close closes once and repeated clicks cannot spawn more prompts', async () => {
  let answer!: (value: { response: number }) => void
  data.show.mockImplementation(() => new Promise(resolve => { answer = resolve }))
  const win = new Window()
  attachAudienceCloseGuard(win as any, () => true)
  win.close(); win.close()
  expect(data.show).toHaveBeenCalledTimes(1)
  answer({ response: 1 }); await flush()
  expect(win.destroyed).toBe(true)
})
it('layout removal bypasses the prompt and a stale answer cannot close a replacement', async () => {
  const win = new Window()
  attachAudienceCloseGuard(win as any, () => false)
  win.close()
  expect(win.destroyed).toBe(true)
  expect(data.show).not.toHaveBeenCalled()
})
