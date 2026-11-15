import { isRemoteControlEvent } from './remote/event.js'
/**
 * Operator-only IPC for the Syphon output setting.
 *
 * The renderer sends only { enabled, name }; native paths, environment and the
 * runtime mode stay in main. Status is also pushed through state.syphon, but
 * this channel lets the settings dialog show the real result immediately.
 */
import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { getOperatorWindow } from './windows.js'
import type { SyphonSettings, SyphonStatus } from '../shared/types.js'
import type { SyphonConfigureResult } from './syphon-settings.js'

export interface SyphonIpcTarget {
  getStatus(): SyphonStatus
  configure(raw: unknown): Promise<SyphonConfigureResult>
}

function requireOperator(event: IpcMainInvokeEvent): void {
  const operator = getOperatorWindow()
  if (!isRemoteControlEvent(event) && (!operator || operator.isDestroyed() || event.sender !== operator.webContents ||
    event.senderFrame !== operator.webContents.mainFrame)) throw new Error('Operator window required')
}

export function registerSyphonIpc(target: SyphonIpcTarget, channel = 'syphon'): void {
  if (channel === 'syphon') {
    const requireWindowsOperator = (event: IpcMainInvokeEvent): void => {
      requireOperator(event)
      if (isRemoteControlEvent(event) || process.platform !== 'win32') throw new Error('Local Windows operator required')
    }
    ipcMain.handle('spout:graphics-help', async (event) => {
      requireWindowsOperator(event)
      const exePath = process.execPath
      const key = "HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences"
      const quotedExe = exePath.replace(/'/g, "''")
      const gpuInfo = await app.getGPUInfo('basic').catch(() => null) as {
        gpuDevice?: Array<{ gpuPreference?: number; deviceString?: string }>
      } | null
      const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : []
      const options = ([1, 2] as const).map(preference => {
        // Chromium gl::GpuPreference: 2 = low power, 3 = high performance.
        // Windows UserGpuPreferences uses 1 and 2 for the same modes.
        const names = [...new Set(devices.filter(d => d.gpuPreference === preference + 1)
          .map(d => d.deviceString).filter((name): name is string => typeof name === 'string' && !!name.trim()))]
        const powershell = `$cueDeckGpuKey = '${key}'; if (-not (Test-Path -LiteralPath $cueDeckGpuKey)) { New-Item -Path $cueDeckGpuKey -Force | Out-Null }; $cueDeckGpuValue = Get-ItemPropertyValue -LiteralPath $cueDeckGpuKey -Name '${quotedExe}' -ErrorAction SilentlyContinue; $cueDeckGpuValue = ($cueDeckGpuValue -split ';' | Where-Object { $_ -and $_ -notmatch '^GpuPreference=' }) -join ';'; New-ItemProperty -LiteralPath $cueDeckGpuKey -Name '${quotedExe}' -PropertyType String -Value ('GpuPreference=${preference};' + $cueDeckGpuValue) -Force | Out-Null`
        return { preference, name: names.length === 1 ? names[0] : null, powershell }
      })
      return { exePath, options }
    })
    ipcMain.handle('spout:open-graphics-settings', async (event) => {
      requireWindowsOperator(event)
      await shell.openExternal('ms-settings:display-advancedgraphics')
    })
  }
  ipcMain.handle(`${channel}:status`, (event) => {
    requireOperator(event)
    return target.getStatus()
  })
  ipcMain.handle(`${channel}:configure`, async (event, raw: unknown) => {
    requireOperator(event)
    // The manager re-validates too; this keeps the channel contract explicit.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings object required')
    return target.configure(raw as Partial<SyphonSettings>)
  })
}
