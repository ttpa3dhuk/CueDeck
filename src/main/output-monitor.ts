import type { BrowserWindow } from 'electron'
import type { MonitorRole } from '../shared/types.js'
import { createHiddenSpeakerWindow, getActiveWindows, getOperatorWindow } from './windows.js'
import { store } from './state.js'

/**
 * Монитор выхода у оператора: раз в INTERVAL_MS снимаем capturePage()
 * с окна суфлёра (без суфлёра в раскладке — зала), ужимаем и шлём оператору
 * кадром `monitor:frame`. capturePage() берёт картинку из компоновщика
 * Chromium — прав на запись экрана (macOS Screen Recording) не требует.
 *
 * В solo-раскладке настоящего суфлёра нет — держим скрытое окно суфлёра
 * (createHiddenSpeakerWindow), чтобы готовить проект без второго экрана.
 */

const INTERVAL_MS = 500
const FRAME_WIDTH = 480 // px; ~15–25 КБ JPEG — безопасно слать по IPC 2 раза/с
const JPEG_QUALITY = 70

// Пропускаем тик, пока предыдущий кадр ещё снимается/жмётся.
let inFlight = false

// Скрытый суфлёр solo-режима; в остальных раскладках уничтожается.
let ghost: BrowserWindow | null = null

export function startOutputMonitor(): void {
  setInterval(() => {
    const s = store.get()
    const op = getOperatorWindow()
    const opAlive = op !== undefined && !op.isDestroyed()

    const wantGhost = s.outputMonitorsEnabled && opAlive && s.layout === 'solo'
    if (wantGhost && !ghost) ghost = createHiddenSpeakerWindow()
    if (!wantGhost && ghost) {
      if (!ghost.isDestroyed()) ghost.destroy()
      ghost = null
    }

    if (!s.outputMonitorsEnabled || !opAlive || op.isMinimized() || inFlight) return

    // Суфлёр в приоритете (настоящий или скрытый), без него — зал
    // (та же логика, что у панели в окне оператора).
    const windows = getActiveWindows()
    const speakerWin = windows.get('speaker') ?? (ghost && !ghost.isDestroyed() ? ghost : null)
    const win = speakerWin ?? windows.get('audience')
    if (!win || win.isDestroyed()) return
    const role: MonitorRole = speakerWin ? 'speaker' : 'audience'

    inFlight = true
    win.webContents
      // stayHidden — скрытый суфлёр остаётся скрытым и при этом отрисовывается
      .capturePage(undefined, { stayHidden: true })
      .then((image) => {
        if (op.isDestroyed() || image.isEmpty()) return
        const scaled =
          image.getSize().width > FRAME_WIDTH ? image.resize({ width: FRAME_WIDTH }) : image
        const dataUrl = `data:image/jpeg;base64,${scaled.toJPEG(JPEG_QUALITY).toString('base64')}`
        op.webContents.send('monitor:frame', { role, dataUrl })
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
      })
  }, INTERVAL_MS)
}
