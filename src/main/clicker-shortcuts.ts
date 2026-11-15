type ShortcutRegistrar = {
  register(key: string, callback: () => void): boolean
  unregister(key: string): void
}

const KEYS = ['PageDown', 'PageUp', 'Right', 'Left', 'Down', 'Up'] as const

/** Системный перехват нужен вне окна оператора; внутри клавиши обрабатывает renderer. */
export function createClickerShortcutManager(
  shortcuts: ShortcutRegistrar,
  operatorFocused: () => boolean,
  forward: () => void,
  back: () => void,
): {
  suspend: () => void
  apply: (global: boolean, arrows: boolean, axis?: 'horizontal' | 'vertical') => { global: boolean; arrows: boolean }
} {
  const suspend = (): void => {
    for (const key of KEYS) shortcuts.unregister(key)
  }

  const apply = (global: boolean, arrows: boolean, axis: 'horizontal' | 'vertical' = 'horizontal'): { global: boolean; arrows: boolean } => {
    suspend()
    if (!global) return { global: false, arrows: false }

    const okPages = shortcuts.register('PageDown', forward) && shortcuts.register('PageUp', back)
    if (!okPages) {
      shortcuts.unregister('PageDown')
      shortcuts.unregister('PageUp')
      return { global: false, arrows: false }
    }

    let okArrows = false
    if (arrows) {
      const next = axis === 'vertical' ? 'Down' : 'Right'
      const prev = axis === 'vertical' ? 'Up' : 'Left'
      okArrows = shortcuts.register(next, forward) && shortcuts.register(prev, back)
      if (!okArrows) {
        shortcuts.unregister(next)
        shortcuts.unregister(prev)
      }
    }
    // Успех регистрации проверили, но в окне оператора клавиши нужны полям ввода.
    if (operatorFocused()) suspend()
    return { global: true, arrows: okArrows }
  }

  return { suspend, apply }
}
