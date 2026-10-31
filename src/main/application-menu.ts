import { BrowserWindow, Menu } from 'electron'

/** setApplicationMenu also reattaches menus to existing Windows outputs. */
export function setOperatorApplicationMenu(menu: Menu, operator: BrowserWindow | undefined, platform = process.platform): void {
  Menu.setApplicationMenu(menu)
  if (platform === 'darwin') return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== operator && !win.isDestroyed()) win.removeMenu()
  }
}
