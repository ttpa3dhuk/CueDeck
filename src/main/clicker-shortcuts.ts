type ShortcutRegistrar = {
  register(key: string, callback: () => void): boolean
  unregister(key: string): void
}

const KEYS = ['PageDown', 'PageUp', 'Right', 'Left'] as const

/** Системный перехват нужен вне окна оператора; внутри клавиши обрабатывает renderer. */
export function createClickerShortcutManager(
  shortcuts: ShortcutRegistrar,
  operatorFocused: () => boolean,
  forward: () => void,
  back: () => void,
): {
  suspend: () => void
  apply: (global: boolean, arrows: boolean) => { global: boolean; arrows: boolean }
} {
  const suspend = (): void => {
    for (const key of KEYS) shortcuts.unregister(key)
  }

  const apply = (global: boolean, arrows: boolean): { global: boolean; arrows: boolean } => {
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
      okArrows = shortcuts.register('Right', forward) && shortcuts.register('Left', back)
      if (!okArrows) {
        shortcuts.unregister('Right')
        shortcuts.unregister('Left')
      }
    }
    // Успех регистрации проверили, но в окне оператора клавиши нужны полям ввода.
    if (operatorFocused()) suspend()
    return { global: true, arrows: okArrows }
  }

  return { suspend, apply }
}
