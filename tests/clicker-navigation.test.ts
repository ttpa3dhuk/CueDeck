import { describe, it, expect, vi } from 'vitest'
import { createClickerNavigation } from '../src/main/clicker-navigation'
import type { FileKind } from '../src/shared/types'

describe('clicker PROGRAM navigation', () => {
  it('ignores repeated forward/back presses throughout a standalone clip', () => {
    const next = vi.fn(), prev = vi.fn()
    const nav = createClickerNavigation(() => 'video', next, prev)
    for (let i = 0; i < 10; i++) { nav.next(); nav.prev() }
    expect(next).not.toHaveBeenCalled()
    expect(prev).not.toHaveBeenCalled()
  })
  it('delegates presentation clicks unchanged, including embedded videos and animation steps', async () => {
    const next = vi.fn(async () => {}), prev = vi.fn()
    const nav = createClickerNavigation(() => 'pptx', next, prev)
    await nav.next()
    await nav.next()
    nav.prev()
    expect(next).toHaveBeenCalledTimes(2)
    expect(prev).toHaveBeenCalledOnce()
  })
  it('uses current PROGRAM kind rather than the kind at registration or in PREVIEW', () => {
    let kind: FileKind = 'pdf'
    const next = vi.fn(), prev = vi.fn()
    const nav = createClickerNavigation(() => kind, next, prev)
    nav.next()
    kind = 'video'
    nav.next(); nav.prev()
    expect(next).toHaveBeenCalledOnce()
    expect(prev).not.toHaveBeenCalled()
    kind = 'pptx'
    nav.prev()
    expect(prev).toHaveBeenCalledOnce()
  })
})
