import { createRequire } from 'node:module'
import { screen } from 'electron'

export interface CurrentDisplayMode {
  width: number | null
  height: number | null
  refreshRate: number | null
}

const unknown = (): CurrentDisplayMode => ({ width: null, height: null, refreshRate: null })
const positive = (n: number): number | null => Number.isFinite(n) && n > 0 ? n : null

/** Current OS-selected display mode; this does not measure the HDMI wire timing. */
export function currentDisplayMode(display: Electron.Display): CurrentDisplayMode {
  if (!Number.isInteger(display.id) || display.id < 0) return unknown()
  const refreshRate = positive(display.displayFrequency)
  try {
    if (process.platform === 'darwin') return macMode(display.id, refreshRate)
    if (process.platform === 'win32') return windowsMode(display, refreshRate)
  } catch {
    // Native API may be unavailable in a test runner or on a disconnected output.
  }
  return { width: null, height: null, refreshRate }
}

let readMacMode: ((id: number, electronRate: number | null) => CurrentDisplayMode) | null = null

function macMode(id: number, electronRate: number | null): CurrentDisplayMode {
  if (!readMacMode) readMacMode = makeMacReader()
  return readMacMode(id, electronRate)
}

function makeMacReader(): (id: number, electronRate: number | null) => CurrentDisplayMode {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const copy = cg.func('void *CGDisplayCopyDisplayMode(uint32_t display)')
  const width = cg.func('size_t CGDisplayModeGetWidth(void *mode)')
  const height = cg.func('size_t CGDisplayModeGetHeight(void *mode)')
  const frequency = cg.func('double CGDisplayModeGetRefreshRate(void *mode)')
  const release = cg.func('void CGDisplayModeRelease(void *mode)')
  return (id, electronRate) => {
    const mode = copy(id)
    if (!mode) return { width: null, height: null, refreshRate: electronRate }
    try {
      // The selected macOS mode's size matches Displays/System Profiler.
      // PixelWidth/Height instead describe the HiDPI backing framebuffer
      // (e.g. selected 1920×1080, backing 3840×2160).
      return {
        width: positive(Number(width(mode))),
        height: positive(Number(height(mode))),
        refreshRate: positive(Number(frequency(mode))) ?? electronRate,
      }
    } finally {
      release(mode)
    }
  }
}

let readWindowsMode: ((display: Electron.Display, electronRate: number | null) => CurrentDisplayMode) | null = null

function windowsMode(display: Electron.Display, electronRate: number | null): CurrentDisplayMode {
  if (!readWindowsMode) readWindowsMode = makeWindowsReader()
  return readWindowsMode(display, electronRate)
}

function makeWindowsReader(): (display: Electron.Display, electronRate: number | null) => CurrentDisplayMode {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  const user = koffi.load('user32.dll')
  const fromRect = user.func('intptr_t __stdcall MonitorFromRect(const void *rect, uint32_t flags)')
  const monitorInfo = user.func('int __stdcall GetMonitorInfoW(intptr_t monitor, void *info)')
  const settings = user.func('int __stdcall EnumDisplaySettingsW(str16 device, int32 mode, void *devmode)')

  return (display, electronRate) => {
    // Electron bounds are DIP. Convert a point inside this exact display to
    // native screen coordinates before asking Windows which monitor owns it.
    const centre = screen.dipToScreenPoint({
      x: Math.floor(display.bounds.x + display.bounds.width / 2),
      y: Math.floor(display.bounds.y + display.bounds.height / 2),
    })
    const rect = Buffer.alloc(16)
    rect.writeInt32LE(centre.x, 0)
    rect.writeInt32LE(centre.y, 4)
    rect.writeInt32LE(centre.x + 1, 8)
    rect.writeInt32LE(centre.y + 1, 12)
    const monitor = fromRect(rect, 0) // MONITOR_DEFAULTTONULL
    if (!monitor) return { width: null, height: null, refreshRate: electronRate }

    // MONITORINFOEXW: cbSize + rcMonitor + rcWork + dwFlags + szDevice[32].
    const info = Buffer.alloc(104)
    info.writeUInt32LE(info.length, 0)
    if (!monitorInfo(monitor, info)) return { width: null, height: null, refreshRate: electronRate }
    const name = info.subarray(40).toString('utf16le').split('\0', 1)[0]
    if (!name) return { width: null, height: null, refreshRate: electronRate }

    // DEVMODEW public structure (220 bytes); EnumDisplaySettingsW reads the
    // current mode for the monitor's device name, without changing settings.
    const devmode = Buffer.alloc(220)
    devmode.writeUInt16LE(devmode.length, 68) // dmSize
    if (!settings(name, -1, devmode)) return { width: null, height: null, refreshRate: electronRate }
    return {
      width: positive(devmode.readUInt32LE(172)), // dmPelsWidth
      height: positive(devmode.readUInt32LE(176)), // dmPelsHeight
      // DEVMODE frequency is integer and can round 59.94 to 59 or 60.
      refreshRate: electronRate ?? positive(devmode.readUInt32LE(184)),
    }
  }
}
