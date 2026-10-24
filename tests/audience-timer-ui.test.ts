import { afterEach, expect, it, vi } from 'vitest'
import { createAudienceTimer } from '../src/shared/audience-timer'
const data = vi.hoisted(() => ({ state: null as any, listener: null as any, previews: [] as any[] }))
vi.mock('../src/renderer/shared/bus', () => ({ getState: () => data.state, subscribe: (fn: any) => { data.listener = fn } }))
vi.mock('../src/renderer/shared/audience-timer-view', () => ({ AudienceTimerView: class {
  constructor(_element: any, _container: any, state: any) { data.previews.push(state) }
  render() {}
} }))
vi.mock('../src/renderer/presenter/audience-timer-background', () => ({ AudienceTimerBackground: class { size = { width: 1000, height: 500 } } }))
import { setupAudienceTimerUi } from '../src/renderer/presenter/audience-timer-ui'

function mount() {
  vi.useFakeTimers()
  data.state = { audienceTimer: createAudienceTimer({ mode: 'countdown', durationMs: 90000 }), blackout: true }
  data.previews = []
  const elements = new Map<string, any>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, textContent: '', disabled: false,
      classList: { toggle() {} }, setAttribute() {}, blur() {}, focus() {}, style: {},
      setPointerCapture() {}, releasePointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 300 }) })
    return elements.get(id)
  }
  const configure = vi.fn(async (config: any) => {
    data.state.audienceTimer = { ...data.state.audienceTimer, ...config }
    data.listener()
  })
  vi.stubGlobal('document', { getElementById: element, activeElement: null })
  vi.stubGlobal('window', { setInterval, api: { audienceTimer: { configure } } })
  const begin = setupAudienceTimerUi(vi.fn(), vi.fn())
  return { element, configure, begin }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('updates appearance immediately without exposing a hidden timer or changing its clock and mode', () => {
  const { element, configure } = mount()
  expect(data.previews[1]().timer.visible).toBe(true)
  element('at-color').value = '#ff0000'; element('at-color').oninput()
  element('at-opacity').value = '25'; element('at-opacity').oninput()
  element('at-mode').value = 'clock'; element('at-mode').onchange()
  vi.advanceTimersByTime(1000)
  expect(configure).toHaveBeenCalledTimes(2)
  expect(data.previews[1]().timer).toMatchObject({ color: '#ff0000', backgroundOpacity: .25, mode: 'clock', visible: true })
  expect(data.state.audienceTimer).toMatchObject({ color: '#ff0000', backgroundOpacity: .25, mode: 'countdown', visible: false, running: false, durationMs: 90000 })
})

it('retains immediate colour choices across refreshes and reopening, without resetting an open palette', () => {
  const { element, begin } = mount()
  element('at-color').value = '#abcdef'; element('at-color').oninput()
  data.listener(); vi.advanceTimersByTime(2000)
  expect(element('at-color').value).toBe('#abcdef')
  expect(data.previews[1]().timer.color).toBe('#abcdef')
  begin()
  expect(element('at-color').value).toBe('#abcdef')
})

it('nudges by output pixels, handles Shift, and prevents navigation keys from reaching the clicker', () => {
  const { element } = mount()
  const event = { key: 'ArrowRight', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  element('at-preview').onkeydown(event)
  expect(data.state.audienceTimer.position.x).toBeCloseTo(.851)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(event.stopPropagation).toHaveBeenCalledOnce()
  element('at-preview').onkeydown({ ...event, key: 'ArrowDown', shiftKey: true })
  expect(data.state.audienceTimer.position.y).toBeCloseTo(.9)
})
