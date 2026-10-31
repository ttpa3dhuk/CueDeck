import { getState, subscribe } from './bus'
import { TestScreenView } from './test-screen-view'
import { TEST_SCREEN_BRIGHTNESS, testScreenVisible, type TestScreenInfo } from '../../shared/test-screen'

/** Visibility is synchronous with every state patch, independent of media loading. */
export function setupTestScreen(container: HTMLElement, role: 'audience' | 'speaker', options: { zIndex?: number } = {}): TestScreenView {
  const view = new TestScreenView(container, role)
  view.element.style.position = container === document.body ? 'fixed' : 'absolute'
  view.element.style.zIndex = String(options.zIndex ?? (container === document.body ? 100 : 6))
  view.element.style.pointerEvents = 'none'
  let info: TestScreenInfo = { role, width: null, height: null, refreshRate: null, version: '' }
  let request = 0
  let busy = false
  const render = (): void => {
    const state = getState()
    view.show({ ...info, visible: testScreenVisible(state), brightness: TEST_SCREEN_BRIGHTNESS,
      roleLabel: role === 'speaker' ? 'Prompter' : 'Main screen' })
  }
  const refresh = async (): Promise<void> => {
    if (busy || !testScreenVisible(getState())) return
    busy = true
    const generation = ++request
    const displayId = getState().displayMap[role]
    try {
      const next = await window.api.testScreen.info(role)
      if (generation === request && getState().displayMap[role] === displayId) info = next
    } catch {
      info = { ...info, width: null, height: null, refreshRate: null }
    } finally { busy = false; render() }
  }
  subscribe((_state, patch) => {
    // Discard the previous display's metadata as soon as its assignment changes.
    if (!patch || patch.displayMap) {
      request++
      info = { ...info, width: null, height: null, refreshRate: null }
    }
    render()
    if (!patch || patch.displayMap || patch.testScreen) void refresh()
  })
  render()
  void refresh()
  // OS mode changes can occur without a CueDeck state patch.
  window.setInterval(() => { void refresh() }, 1500)
  return view
}
