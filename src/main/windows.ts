import { attachAudienceCloseGuard } from './audience-close-guard.js'
import { BrowserWindow, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { DisplayMap, Layout, Role } from './layout.js'
import { rolesForLayout } from './layout.js'
import { safeDisplayLayout } from '../shared/display-safety.js'
import { store } from './state.js'
import { WINDOW_TITLES } from '../shared/window-titles.js'
import { getLang } from '../shared/i18n.js'
import { gpuAudiencePhysicalGuard, stopGpuAudienceForNormalOutput } from './gpu-audience-arbiter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PRELOAD = resolve(__dirname, '../preload/index.cjs')

const DEV_TILE = process.env.PRESENTER_DEV_TILE === '1'
const readyWindows = new WeakSet<BrowserWindow>()

// Output surfaces on macOS stay on the desktop. Native fullscreen creates a
// Space and can blank the operator's display when displays share Spaces.
// simpleFullscreen also changes app-wide Dock/menu presentation options.
// Windows audience outputs also stay on the desktop: Chromium shrinks native
// fullscreen by 1px when another window on that monitor becomes active.
const desktopDisplayWindows = new WeakSet<BrowserWindow>()
const layoutClosingWindows = new WeakSet<BrowserWindow>()
const gpuViewWindows = new WeakSet<BrowserWindow>()

function isOutputFullscreen(win: BrowserWindow): boolean {
  return desktopDisplayWindows.has(win) || win.isFullScreen()
}

interface RendererTarget {
  entry: 'presenter' | 'audience' | 'stream' | 'overlay' | 'omt-audio' | 'gpu-view'
  role: Role | 'stream' | 'omt-timer' | 'omt-audio' | 'audience-gpu-view'
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

function createWindow(role: Role, displayId: number | undefined, fullscreen: boolean, windowed = false, audienceAlwaysOnTop = true, gpuView = false): BrowserWindow {
  const fillDisplay = fullscreen && !DEV_TILE && !windowed
  const macDisplayWindow = process.platform === 'darwin' && fillDisplay
  const winAudienceDisplay = process.platform === 'win32' && role === 'audience' && fillDisplay
  const desktopDisplayWindow = macDisplayWindow || winAudienceDisplay
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
    ...(role === 'operator' ? { minWidth: 1000, minHeight: 600 } : {}),
    show: false,
    fullscreen: fillDisplay && !desktopDisplayWindow,
    ...(desktopDisplayWindow ? {
      frame: false,
      roundedCorners: false,
      fullscreenable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      // Otherwise AppKit constrains even a frameless window below the menu
      // bar, shifting the output down and cropping its bottom edge.
      ...(macDisplayWindow ? { enableLargerThanScreen: true } : {
        // frame:false alone retains Windows non-client resizing margins.
        thickFrame: false,
        maximizable: false,
      }),
    } : {}),
    backgroundColor: role === 'audience' ? '#000000' : '#1a1a1a',
    title: WINDOW_TITLES[role],
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Restored/live program audio must start without a click on an output.
      autoplayPolicy: 'no-user-gesture-required',
      // The operator owns video:ended/loop advancement. Chromium must keep
      // its video and clock running when minimized or covered by a DJ app;
      // otherwise the audience repeatedly seeks around an expired clock.
      backgroundThrottling: false,
    },
  })
  if (gpuView) gpuViewWindows.add(win)
  if (role === 'audience' && windowed) {
    attachAudienceCloseGuard(win, () => activeWindows.get('audience') === win && !layoutClosingWindows.has(win))
  }
  if (desktopDisplayWindow) {
    desktopDisplayWindows.add(win)
    const targetDisplayId = screen.getDisplayMatching(bounds).id
    // Native fullscreen used to follow display resolution/rotation changes.
    // A desktop output surface must update its own bounds instead.
    const onMetricsChanged = (_event: Electron.Event, display: Electron.Display, metrics: string[]) => {
      if (!win.isDestroyed() && display.id === targetDisplayId && metrics.includes('bounds')) {
        win.setBounds(display.bounds)
      }
    }
    screen.on('display-metrics-changed', onMetricsChanged)
    win.once('closed', () => screen.removeListener('display-metrics-changed', onMetricsChanged))
  }

  // Меню приложения на Windows садится в каждое окно строкой File / View / Help.
  // Зал и суфлёр — выходные поверхности, там её быть не должно (на маке меню
  // живёт вверху экрана и окна не трогает).
  if (role !== 'operator' && process.platform !== 'darwin') win.removeMenu()

  if (gpuView) gpuAudiencePhysicalGuard()?.attachPhysical?.(win)
  loadRenderer(win, gpuView ? { entry: 'gpu-view', role: 'audience-gpu-view' } : rendererForRole(role))

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    readyWindows.add(win)
    if (fillDisplay) {
      win.setBounds(bounds)
      if (macDisplayWindow) {
        // The pinned mode covers the menu bar and Dock on this display.
        // Neither mode changes NSApp presentation options or creates a Space.
        if (role !== 'audience' || audienceAlwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
      } else if (winAudienceDisplay) {
        win.setAlwaysOnTop(audienceAlwaysOnTop)
      } else {
        win.setFullScreen(true)
        if (role === 'audience') win.setAlwaysOnTop(audienceAlwaysOnTop)
      }
    }
    if (role === 'audience' && !store.get().audienceOutputEnabled) return
    if (role !== 'operator') win.showInactive()
    else win.show()
    if (role === 'operator') win.focus()
  })

  if (!gpuView) store.registerWindow(role, win)
  if (role === 'audience') win.once('closed', () => {
    if (activeWindows.get('audience') === win && !layoutClosingWindows.has(win)) {
      store.patch({ audienceOutputEnabled: false })
    }
  })
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

function unregisterIfOwned(role: Role, win: BrowserWindow): void {
  if (store.registeredWindow?.(role) === win) store.unregisterWindow(role)
}

/** Replace only the physical audience surface; the OSR audience keeps state/audio. */
export function reconcileGpuAudienceDisplay(): void {
  const existing = activeWindows.get('audience')
  if (!existing || existing.isDestroyed()) return
  const gpuView = gpuAudiencePhysicalGuard() !== null
  if (gpuViewWindows.has(existing) === gpuView) return
  const state = store.get()
  unregisterIfOwned('audience', existing)
  layoutClosingWindows.add(existing)
  existing.destroy()
  const windowed = state.audienceWindowed
  activeWindows.set('audience', createWindow('audience', state.displayMap.audience, !windowed,
    windowed, state.audienceAlwaysOnTop, gpuView))
}

export function applyLayout(layout: Layout, displayMap: DisplayMap, audienceWindowed = false, audienceAlwaysOnTop = true): Map<Role, BrowserWindow> {
  if (!DEV_TILE) {
    const safe = safeDisplayLayout(layout, displayMap, screen.getAllDisplays(), audienceWindowed)
    layout = safe.layout
    displayMap = safe.displayMap
  }
  const gpuView = gpuAudiencePhysicalGuard() !== null
  const desiredRoles = new Set<Role>(rolesForLayout(layout))

  // Close windows whose role is no longer active
  for (const [role, win] of activeWindows) {
    if (!desiredRoles.has(role)) {
      unregisterIfOwned(role, win)
      if (!win.isDestroyed()) { layoutClosingWindows.add(win); win.close() }
      activeWindows.delete(role)
    }
  }

  // Open missing windows and reposition existing ones
  for (const role of desiredRoles) {
    const windowed = (role === 'audience' && audienceWindowed) ||
      (role === 'speaker' && displayMap.speaker === displayMap.operator)
    const fullscreen = (role === 'audience' || role === 'speaker') && !windowed
    const existing = activeWindows.get(role)
    if (existing && !existing.isDestroyed() && (role !== 'audience' || gpuViewWindows.has(existing) === gpuView)) {
      if (!DEV_TILE) {
        const target = windowed
          ? windowedAudienceBounds(displayMap[role])
          : displayBounds(displayMap[role])
        const displayChanged =
          screen.getDisplayMatching(existing.getBounds()).id !==
          screen.getDisplayMatching(target).id
        const modeChanged = isOutputFullscreen(existing) !== fullscreen
        if (displayChanged || modeChanged) {
          // Переезд fullscreen-окна между экранами через setBounds ненадёжен:
          // macOS Spaces возвращает окно на прежний дисплей даже после
          // 'leave-full-screen'. Пересоздаём окно на целевом экране — тот же
          // путь, что при старте, работает детерминированно.
          unregisterIfOwned(role, existing)
          layoutClosingWindows.add(existing)
          existing.destroy()
          activeWindows.set(role, createWindow(role, displayMap[role], fullscreen, windowed, audienceAlwaysOnTop, role === 'audience' && gpuView))
        } else if (!isOutputFullscreen(existing)) {
          existing.setBounds(target)
        }
        if (!displayChanged && !modeChanged && role === 'audience' && fullscreen) {
          if (process.platform === 'darwin' && desktopDisplayWindows.has(existing)) existing.setAlwaysOnTop(audienceAlwaysOnTop, 'screen-saver')
          else existing.setAlwaysOnTop(audienceAlwaysOnTop)
        }
      }
    } else {
      if (existing && !existing.isDestroyed()) {
        unregisterIfOwned(role, existing)
        layoutClosingWindows.add(existing)
        existing.destroy()
      }
      const win = createWindow(role, displayMap[role], fullscreen, windowed, audienceAlwaysOnTop, role === 'audience' && gpuView)
      activeWindows.set(role, win)
    }
  }

  store.patch({ layout, displayMap, audienceWindowed, audienceAlwaysOnTop })
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

/** Release only the physical screen; retain the program renderer and clocks. */
export function setAudienceOutputEnabled(enabled: boolean): void {
  const state = store.get()
  if (state.layout === 'solo') return
  store.patch({ audienceOutputEnabled: enabled })
  let audience = activeWindows.get('audience')
  if (enabled && (!audience || audience.isDestroyed())) {
    applyLayout(state.layout, state.displayMap, state.audienceWindowed, state.audienceAlwaysOnTop)
    audience = activeWindows.get('audience')
  }
  if (!audience || audience.isDestroyed()) return
  if (!enabled) {
    audience.hide()
    const operator = getOperatorWindow()
    if (operator && !operator.isDestroyed()) operator.focus()
  } else if (readyWindows.has(audience)) {
    audience.showInactive()
  }
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
    // Размер — ровно картинка: без рамки (Windows иначе съедает 16 px по
    // ширине, мак — заголовок) и не ужимается под экран мака. Её снимают
    // трансляция и выходы OMT.
    frame: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
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
    // Размер — ровно картинка: без рамки (Windows иначе съедает 16 px по
    // ширине, мак — заголовок) и не ужимается под экран мака. Её снимают
    // трансляция и выходы OMT.
    frame: false,
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
 * Load the real audience renderer after the GPU publisher/listener is ready.
 * Registration must happen after load starts so store's initial state:full is
 * sent on did-finish-load, not into a blank webContents.
 */
export function loadGpuAudiencePage(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.setFrameRate(30)
  loadRenderer(win, { entry: 'audience', role: 'audience' })
  store.registerWindow('audience', win)
}

/**
 * Real audience GPU producer: the actual audience renderer, offscreen
 * with a shared texture. Never shown and never used as a normal hidden audience
 * for stream/OMT/capture. One instance is registered in store as `audience` by
 * the GPU audience mode through the ghost lease. Target is PHYSICAL texture
 * pixels. The offscreen renderer uses its own fixed 1x scale so fractional
 * desktop DPI cannot round a Full HD texture to 1921 pixels. The actual
 * codedSize is still checked by GpuTexturePublisher.
 */
export function createGpuAudienceWindow(targetWidth = 1920, targetHeight = 1080, load = true): BrowserWindow {
  const width = Math.max(16, Math.round(targetWidth))
  const height = Math.max(16, Math.round(targetHeight))
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    title: 'CueDeck (GPU audience)',
    // Windows' invisible resize border contributes to the OSR surface size,
    // even for frame:false. At fractional DPI it can add 1–2 pixels.
    thickFrame: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
    },
  })
  // Windows constrains initial window bounds to the screen/work area, even
  // for hidden OSR windows. Resize after construction, before the first frame.
  // OSR uses the native window's OUTER size. Windows also rounds DIP -> native
  // pixels -> DIP (e.g. requesting 1920 at 115% can return 1921). Correct the
  // request by the observed error, rather than repeating the same rounded size.
  let requestedWidth = width
  let requestedHeight = height
  for (let attempt = 0; attempt < 4; attempt++) {
    const [actualWidth, actualHeight] = win.getSize()
    if (actualWidth === width && actualHeight === height) break
    if (attempt > 0) {
      requestedWidth += width - actualWidth
      requestedHeight += height - actualHeight
    }
    win.setSize(requestedWidth, requestedHeight)
  }
  const [actualWidth, actualHeight] = win.getSize()
  if (actualWidth !== width || actualHeight !== height) {
    win.destroy()
    throw new Error(`GPU audience window size ${actualWidth}x${actualHeight} does not match target ${width}x${height}`)
  }
  win.webContents.setFrameRate(30)
  if (load) loadGpuAudiencePage(win)
  return win
}

/** Render the real confidence monitor using the same DPI-corrected GPU factory. */
export function createGpuPrompterWindow(load = true): BrowserWindow {
  const win = createGpuAudienceWindow(1920, 1080, false)
  if (load) loadGpuPrompterPage(win)
  return win
}

/** Keep the physical/OMT speaker registration independent of this GPU output. */
export function loadGpuPrompterPage(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  loadRenderer(win, { entry: 'presenter', role: 'speaker' })
  store.registerWindow('gpu-prompter', win)
}

/** A display-only GPU consumer: no audience state registration or media load. */
export function createGpuViewWindow(load = true): BrowserWindow {
  const win = new BrowserWindow({
    width: 960, height: 540, show: false, backgroundColor: '#000000',
    title: WINDOW_TITLES.audience,
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win.showInactive())
  if (load) loadGpuViewPage(win)
  return win
}

export function loadGpuViewPage(win: BrowserWindow): void {
  loadRenderer(win, { entry: 'gpu-view', role: 'audience-gpu-view' })
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
type GhostKind = 'normal' | 'gpu-audience'
const ghosts = new Map<GhostRole, { win: BrowserWindow; holders: Set<string>; kind: GhostKind }>()

/**
 * Взять скрытое окно роли (создать, если его нет). `create` зовётся только при
 * создании. GPU audience is a distinct ghost kind: a normal consumer must never
 * silently reuse its offscreen/shared-texture window. The arbiter is called
 * before falling back to a normal ghost; if a GPU ghost still exists, creation
 * is refused rather than returning an incompatible window.
 */
export function acquireGhost(role: GhostRole, holder: string, create: () => BrowserWindow,
                            kind: GhostKind = 'normal'): BrowserWindow {
  const g = ghosts.get(role)
  if (g && !g.win.isDestroyed()) {
    if (g.kind === kind) {
      g.holders.add(holder)
      return g.win
    }
    if (kind === 'normal') {
      stopGpuAudienceForNormalOutput(`ghost:${holder}`)
      const after = ghosts.get(role)
      if (after && !after.win.isDestroyed()) {
        if (after.kind === 'normal') {
          after.holders.add(holder)
          return after.win
        }
        // The stop hook did not release a stale GPU ghost. Normal output must
        // still proceed, so destroy only that incompatible GPU window.
        ghosts.delete(role)
        try { after.win.destroy() } catch { /* already gone */ }
      }
      // GPU ghost was released/destroyed; fall through and create normal.
    } else {
      throw new Error(`incompatible ${role} ghost: existing=${g.kind}, requested=${kind}`)
    }
  }
  const win = create()
  ghosts.set(role, { win, holders: new Set([holder]), kind })
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
