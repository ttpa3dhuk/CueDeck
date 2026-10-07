import { BrowserWindow, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { DisplayMap, Layout, Role } from './layout.js'
import { rolesForLayout } from './layout.js'
import { store } from './state.js'
import { WINDOW_TITLES } from '../shared/window-titles.js'
import { getLang } from '../shared/i18n.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PRELOAD = resolve(__dirname, '../preload/index.cjs')

const DEV_TILE = process.env.PRESENTER_DEV_TILE === '1'

interface RendererTarget {
  entry: 'presenter' | 'audience' | 'stream' | 'overlay' | 'omt-audio'
  role: Role | 'stream' | 'omt-timer' | 'omt-audio'
}

function rendererForRole(role: Role): RendererTarget {
  return role === 'audience' ? { entry: 'audience', role } : { entry: 'presenter', role }
}

function loadRenderer(win: BrowserWindow, target: RendererTarget): void {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  // Язык окна — в адресе: рендерер знает его до первой строки своего кода (i18n.ts).
  const query = `role=${target.role}&lang=${getLang()}`
  if (devServerUrl) {
    win.loadURL(`${devServerUrl}/${target.entry}/index.html?${query}`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${target.entry}/index.html`), {
      search: query,
    })
  }
}

function displayBounds(displayId: number | undefined): Electron.Rectangle {
  const displays = screen.getAllDisplays()
  const d = displays.find((x) => x.id === displayId) ?? screen.getPrimaryDisplay()
  return d.bounds
}

function windowedAudienceBounds(displayId: number | undefined): Electron.Rectangle {
  const b = displayBounds(displayId)
  const w = Math.min(1280, Math.floor(b.width * 0.75))
  const h = Math.round(w * 9 / 16)
  return {
    x: b.x + Math.floor((b.width - w) / 2),
    y: b.y + Math.floor((b.height - h) / 2),
    width: w,
    height: h,
  }
}

function tilePosition(role: Role): Electron.Rectangle {
  const primary = screen.getPrimaryDisplay().workArea
  const w = Math.floor(primary.width / 2)
  const h = Math.floor(primary.height / 2)
  const positions: Record<Role, Electron.Rectangle> = {
    operator: { x: primary.x, y: primary.y, width: w, height: h },
    speaker: { x: primary.x + w, y: primary.y, width: w, height: h },
    audience: { x: primary.x, y: primary.y + h, width: primary.width, height: h },
  }
  return positions[role]
}

function createWindow(role: Role, displayId: number | undefined, fullscreen: boolean, windowed = false): BrowserWindow {
  const bounds = DEV_TILE
    ? tilePosition(role)
    : windowed
      ? windowedAudienceBounds(displayId)
      : displayBounds(displayId)

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    fullscreen: fullscreen && !DEV_TILE && !windowed,
    backgroundColor: role === 'audience' ? '#000000' : '#1a1a1a',
    title: WINDOW_TITLES[role],
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  loadRenderer(win, rendererForRole(role))

  win.once('ready-to-show', () => {
    if (!DEV_TILE && fullscreen && !windowed) {
      win.setBounds(bounds)
      win.setFullScreen(true)
    }
    win.show()
    if (role === 'operator') win.focus()
  })

  store.registerWindow(role, win)
  if (role === 'operator') operatorWindowHook?.(win)
  return win
}

/**
 * Колбэк на каждое создание окна оператора (окно пересоздаётся при переезде на
 * другой дисплей). Через него вешается перехват закрытия — quit-guard.ts;
 * прямой импорт оттуда дал бы цикл windows ↔ ipc ↔ quit-guard, поэтому хук
 * ставит index.ts.
 */
let operatorWindowHook: ((win: BrowserWindow) => void) | null = null

export function setOperatorWindowHook(fn: (win: BrowserWindow) => void): void {
  operatorWindowHook = fn
}

let activeWindows = new Map<Role, BrowserWindow>()


export function applyLayout(layout: Layout, displayMap: DisplayMap, audienceWindowed = false): Map<Role, BrowserWindow> {
  const desiredRoles = new Set<Role>(rolesForLayout(layout))

  // Close windows whose role is no longer active
  for (const [role, win] of activeWindows) {
    if (!desiredRoles.has(role)) {
      store.unregisterWindow(role)
      if (!win.isDestroyed()) win.close()
      activeWindows.delete(role)
    }
  }

  // Open missing windows and reposition existing ones
  for (const role of desiredRoles) {
    const windowed = role === 'audience' && audienceWindowed
    const fullscreen = (role === 'audience' || role === 'speaker') && !windowed
    const existing = activeWindows.get(role)
    if (existing && !existing.isDestroyed()) {
      if (!DEV_TILE) {
        const target = windowed
          ? windowedAudienceBounds(displayMap[role])
          : displayBounds(displayMap[role])
        const displayChanged =
          screen.getDisplayMatching(existing.getBounds()).id !==
          screen.getDisplayMatching(target).id
        const modeChanged = existing.isFullScreen() !== fullscreen
        if (displayChanged || modeChanged) {
          // Переезд fullscreen-окна между экранами через setBounds ненадёжен:
          // macOS Spaces возвращает окно на прежний дисплей даже после
          // 'leave-full-screen'. Пересоздаём окно на целевом экране — тот же
          // путь, что при старте, работает детерминированно.
          store.unregisterWindow(role)
          existing.destroy()
          activeWindows.set(role, createWindow(role, displayMap[role], fullscreen, windowed))
        } else if (!existing.isFullScreen()) {
          existing.setBounds(target)
        }
      }
    } else {
      const win = createWindow(role, displayMap[role], fullscreen, windowed)
      activeWindows.set(role, win)
    }
  }

  store.patch({ layout, displayMap, audienceWindowed })
  return activeWindows
}

/**
 * Перезагрузить все окна на текущем языке (`lang=` в адресе). Нужно смене
 * языка в dev-сборке — см. `app:relaunch` в index.ts. Скрытое окно суфлёра
 * (монитор в solo) тоже здесь: берём все окна, а не только activeWindows.
 */
export function reloadAllWindowsForLang(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const url = win.webContents.getURL()
    if (!/[?&]lang=/.test(url)) continue
    void win.loadURL(url.replace(/([?&]lang=)[a-z]+/, `$1${getLang()}`))
  }
}

export function getActiveWindows(): Map<Role, BrowserWindow> {
  return activeWindows
}

export function getOperatorWindow(): BrowserWindow | undefined {
  return activeWindows.get('operator')
}

/**
 * Скрытое окно суфлёра для solo-режима: рендерит настоящий суфлёрский вид
 * (таймер, заметки, сообщение) в FullHD, но никогда не показывается — живёт
 * только ради capturePage в мониторе оператора (преднастройка проекта дома /
 * в номере без второго экрана). Регистрируется в store как обычный speaker;
 * в activeWindows НЕ попадает, чтобы applyLayout его не трогал — жизненным
 * циклом управляет output-monitor.ts.
 */
export function createHiddenSpeakerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    backgroundColor: '#1a1a1a',
    title: 'CueDeck (monitor)',
    // Размер — ровно картинка (без заголовка окна) и не ужимается под экран
    // мака: её снимают трансляция и выходы OMT.
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Скрытое окно не должно засыпать — иначе таймер на снимках замирает.
      backgroundThrottling: false,
    },
  })
  loadRenderer(win, { entry: 'presenter', role: 'speaker' })
  store.registerWindow('speaker', win)
  return win
}

/**
 * Скрытое окно зала на время трансляции в solo: настоящего зала нет, а
 * трансляция снимает именно окно зала. Регистрируется в store как audience —
 * и тогда звук эфира играет оно, а не оператор (audioRole в shared/video.ts).
 * Жизненным циклом управляет stream/streamer.ts.
 */
export function createHiddenAudienceWindow(width: number, height: number): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: '#000000',
    title: 'CueDeck (hidden audience)',
    // Размер — ровно картинка (без заголовка окна) и не ужимается под экран
    // мака: её снимают трансляция и выходы OMT.
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  loadRenderer(win, { entry: 'audience', role: 'audience' })
  store.registerWindow('audience', win)
  return win
}

/**
 * Окно-кодировщик трансляции: никогда не показывается. Снимает окно зала
 * (getDisplayMedia → захват вкладки внутри Chromium, прав на запись экрана не
 * нужно), кодирует WebCodecs и отдаёт пакеты в main (stream/streamer.ts).
 */
export function createStreamEncoderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    title: 'CueDeck (encoder)',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  loadRenderer(win, { entry: 'stream', role: 'stream' })
  return win
}

/**
 * Оверлей для выхода OMT (omt/outputs.ts): offscreen, прозрачный фон — кадры
 * берутся событием `paint` вместе с альфой. Никогда не показывается. Получает
 * состояние, как обычное окно (store.registerWindow).
 */
export function createOmtOverlayWindow(width: number, height: number): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    title: 'CueDeck (OMT timer)',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  })
  loadRenderer(win, { entry: 'overlay', role: 'omt-timer' })
  store.registerWindow('omt-timer', win)
  return win
}

/** Окно звука выхода OMT «Зал» (omt/outputs.ts): снимает звук вкладки зала. Никогда не показывается. */
export function createOmtAudioWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    title: 'CueDeck (OMT audio)',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  loadRenderer(win, { entry: 'omt-audio', role: 'omt-audio' })
  return win
}

// ── Скрытые окна зала и суфлёра — общие на всех ─────────────────────────────
// Когда настоящего окна роли в раскладке нет, его держит скрытым тот, кому
// оно нужно: трансляция (зал в solo), монитор оператора (суфлёр в solo),
// выходы OMT (зал/суфлёр в любой раскладке). Окно регистрируется в store под
// своей ролью, а две регистрации одной роли перебивают друг друга — поэтому
// скрытое окно на роль одно, со списком держателей. Ушёл последний — закрыто.

type GhostRole = 'audience' | 'speaker'
const ghosts = new Map<GhostRole, { win: BrowserWindow; holders: Set<string> }>()

/** Взять скрытое окно роли (создать, если его нет). `create` зовётся только при создании. */
export function acquireGhost(role: GhostRole, holder: string, create: () => BrowserWindow): BrowserWindow {
  const g = ghosts.get(role)
  if (g && !g.win.isDestroyed()) {
    g.holders.add(holder)
    return g.win
  }
  const win = create()
  ghosts.set(role, { win, holders: new Set([holder]) })
  win.on('closed', () => {
    if (ghosts.get(role)?.win === win) ghosts.delete(role)
  })
  return win
}

/** Отпустить; последний держатель закрывает окно. */
export function releaseGhost(role: GhostRole, holder: string): void {
  const g = ghosts.get(role)
  if (!g || !g.holders.delete(holder) || g.holders.size > 0) return
  ghosts.delete(role)
  if (!g.win.isDestroyed()) g.win.destroy()
}

/** Скрытое окно роли, если его кто-то держит. */
export function ghostWindow(role: GhostRole): BrowserWindow | null {
  const g = ghosts.get(role)
  return g && !g.win.isDestroyed() ? g.win : null
}
