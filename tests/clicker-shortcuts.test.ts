import { describe, expect, it, vi } from 'vitest'
import { createClickerShortcutManager } from '../src/main/clicker-shortcuts'

function setup() {
  const registered = new Map<string, () => void>()
  let focused = true
  const forward = vi.fn(), back = vi.fn()
  const shortcuts = {
    register: vi.fn((key: string, callback: () => void) => {
      registered.set(key, callback)
      return true
    }),
    unregister: vi.fn((key: string) => { registered.delete(key) }),
  }
  const manager = createClickerShortcutManager(shortcuts, () => focused, forward, back)
  return { registered, shortcuts, manager, forward, back, setFocused: (v: boolean) => { focused = v } }
}

describe('global clicker focus', () => {
  it('releases arrows for operator inputs and restores them outside CueDeck', () => {
    const t = setup()
    expect(t.manager.apply(true, true)).toEqual({ global: true, arrows: true })
    expect(t.registered.size).toBe(0)

    t.setFocused(false)
    expect(t.manager.apply(true, true)).toEqual({ global: true, arrows: true })
    expect([...t.registered.keys()]).toEqual(['PageDown', 'PageUp', 'Right', 'Left'])
    t.registered.get('Right')?.()
    t.registered.get('Left')?.()
    expect(t.forward).toHaveBeenCalledOnce()
    expect(t.back).toHaveBeenCalledOnce()

    t.setFocused(true)
    t.manager.suspend()
    expect(t.registered.size).toBe(0)
  })

  it('does not register arrows unless requested and releases everything when disabled', () => {
    const t = setup()
    t.setFocused(false)
    expect(t.manager.apply(true, false)).toEqual({ global: true, arrows: false })
    expect([...t.registered.keys()]).toEqual(['PageDown', 'PageUp'])
    expect(t.manager.apply(false, true)).toEqual({ global: false, arrows: false })
    expect(t.registered.size).toBe(0)
  })

  it('drops a partial arrow pair if registration fails', () => {
    const t = setup()
    t.setFocused(false)
    t.shortcuts.register.mockImplementation((key: string, callback: () => void) => {
      if (key === 'Left') return false
      t.registered.set(key, callback)
      return true
    })
    expect(t.manager.apply(true, true)).toEqual({ global: true, arrows: false })
    expect([...t.registered.keys()]).toEqual(['PageDown', 'PageUp'])
  })
})
