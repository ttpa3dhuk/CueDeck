import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { resolveFrameStepDeck, resolveRangeActionForKey } from '../src/renderer/shared/video-focus'

const base = {
  code: 'ArrowRight',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  focusedDeck: 'program' as const,
  hasProgramVideo: true,
  hasPreviewVideo: true,
}

describe('player control click focus', () => {
  const source = readFileSync(join(__dirname, '../src/renderer/presenter/main.ts'), 'utf8')
  const typingGuard = source.slice(source.indexOf('function isTypingTarget('), source.indexOf('function focusedFrameDeck('))
  const keyboard = source.slice(source.indexOf('function setupKeyboard('))
  const clickHandler = keyboard.slice(keyboard.indexOf("window.addEventListener('click',"), keyboard.indexOf('\n  // Frame stepping'))

  function click(tag: string, type = ''): { focused: number; blurred: number } {
    const result = { focused: 0, blurred: 0 }
    const player = { focus: () => result.focused++ }
    class Element {
      type = type
      closest(selector: string): unknown { return selector === '[data-frame-player]' ? player : null }
      blur(): void { result.blurred++ }
    }
    class Select extends Element {}
    class Input extends Element {}
    class TextArea extends Element {}
    const activeElement = tag === 'select' ? new Select() : tag === 'input' ? new Input() : tag === 'textarea' ? new TextArea() : new Element()
    runInNewContext(ts.transpile(typingGuard + clickHandler), {
      HTMLElement: Element, HTMLSelectElement: Select, HTMLInputElement: Input, HTMLTextAreaElement: TextArea,
      document: { activeElement, body: {} },
      window: { addEventListener: (_: string, callback: () => void) => callback() },
    })
    return result
  }

  it('keeps an opened native select and editable fields focused inside a player', () => {
    for (const [tag, type] of [['select', ''], ['textarea', ''], ['input', 'text'], ['input', 'number']]) {
      expect(click(tag, type)).toEqual({ focused: 0, blurred: 0 })
    }
  })

  it('still transfers transport button, checkbox and scrub focus to the player', () => {
    for (const [tag, type] of [['button', ''], ['input', 'checkbox'], ['input', 'range']]) {
      expect(click(tag, type)).toEqual({ focused: 1, blurred: 0 })
    }
  })
})

describe('frame-step focus contract', () => {
  it('steps the focused video player only', () => {
    expect(resolveFrameStepDeck(base)).toBe('program')
    expect(resolveFrameStepDeck({ ...base, focusedDeck: 'preview' })).toBe('preview')
  })

  it('leaves slides/clicker alone outside a player', () => {
    expect(resolveFrameStepDeck({ ...base, focusedDeck: null })).toBeNull()
  })

  it('does not steal modified arrows', () => {
    expect(resolveFrameStepDeck({ ...base, shiftKey: true })).toBeNull()
    expect(resolveFrameStepDeck({ ...base, ctrlKey: true })).toBeNull()
    expect(resolveFrameStepDeck({ ...base, altKey: true })).toBeNull()
    expect(resolveFrameStepDeck({ ...base, metaKey: true })).toBeNull()
  })

  it('does not step a focused surface with no video', () => {
    expect(resolveFrameStepDeck({ ...base, hasProgramVideo: false })).toBeNull()
    expect(resolveFrameStepDeck({ ...base, focusedDeck: 'preview', hasPreviewVideo: false })).toBeNull()
  })

  it('ignores other keys', () => {
    expect(resolveFrameStepDeck({ ...base, code: 'ArrowUp' })).toBeNull()
    expect(resolveFrameStepDeck({ ...base, code: 'KeyA' })).toBeNull()
  })
})

describe('I/O range keys', () => {
  it('clears only the matching edge with Alt/Option and preserves focus guards', () => {
    expect(resolveRangeActionForKey({ ...base, code: 'KeyI', altKey: true })).toEqual({ deck: 'program', edge: 'clear-in' })
    expect(resolveRangeActionForKey({ ...base, code: 'KeyO', altKey: true, focusedDeck: 'preview' })).toEqual({ deck: 'preview', edge: 'clear-out' })
    expect(resolveRangeActionForKey({ ...base, code: 'KeyI', altKey: true, focusedDeck: null })).toBeNull()
    expect(resolveRangeActionForKey({ ...base, code: 'KeyI', altKey: true, ctrlKey: true })).toBeNull()
  })
  it('sets In/Out on the focused video deck at the playhead', () => {
    expect(resolveRangeActionForKey({ ...base, code: 'KeyI' })).toEqual({ deck: 'program', edge: 'in' })
    expect(resolveRangeActionForKey({ ...base, code: 'KeyO', focusedDeck: 'preview' })).toEqual({ deck: 'preview', edge: 'out' })
  })

  it('is inert outside a focused video player, with modifiers, or for other keys', () => {
    expect(resolveRangeActionForKey({ ...base, code: 'KeyI', focusedDeck: null })).toBeNull()
    expect(resolveRangeActionForKey({ ...base, code: 'KeyI', hasProgramVideo: false })).toBeNull()
    expect(resolveRangeActionForKey({ ...base, code: 'KeyI', shiftKey: true })).toBeNull()
    expect(resolveRangeActionForKey({ ...base, code: 'KeyX' })).toBeNull()
  })
})

describe('player focus markup', () => {
  const html = readFileSync(join(__dirname, '../src/renderer/presenter/index.html'), 'utf8')
  const tag = (id: string): string => html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0] ?? ''

  it('marks the real transport roots, not generic playback/navigation bars', () => {
    expect(tag('video-controls')).toContain('data-frame-player="program"')
    expect(tag('video-controls')).toContain('tabindex="-1"')
    expect(tag('preview-video-controls')).toContain('data-frame-player="preview"')
    expect(tag('preview-video-controls')).toContain('tabindex="-1"')
    expect(tag('program-playback')).not.toContain('data-frame-player')
    expect(tag('preview-playback')).not.toContain('data-frame-player')
  })

  it('keeps scrub values on the exact clock instead of snapping to 100 ms', () => {
    for (const id of ['video-scrub', 'preview-video-scrub']) {
      expect(tag(id)).toContain('step="any"')
      expect(tag(id)).not.toContain('step="0.1"')
    }
  })

  it('keeps the player stages focusable as well', () => {
    expect(tag('current-slide')).toContain('data-frame-player="program"')
    expect(tag('preview-slide')).toContain('data-frame-player="preview"')
  })
})

describe('scrub drag timecode wiring', () => {
  const source = readFileSync(join(__dirname, '../src/renderer/presenter/main.ts'), 'utf8')

  it('shows the pending MM:SS:-- drag value instead of a whole-second clock', () => {
    expect(source).toContain("paintScrubDrag('program', Number(videoScrub!.value))")
    expect(source).toContain("paintScrubDrag('preview', Number(previewVideoScrub!.value))")
    expect(source).not.toContain("formatClock(Number(videoScrub!.value))")
    expect(source).not.toContain("formatClock(Number(previewVideoScrub!.value))")
    expect(source).toContain('if (videoTime && !draggingScrub.program)')
    expect(source).toContain('if (previewVideoTime && !draggingScrub.preview)')
  })
})
