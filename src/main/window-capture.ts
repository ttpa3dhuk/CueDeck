import { BrowserWindow, desktopCapturer, ipcMain, systemPreferences, screen } from 'electron'
import { normalizeWindowFps } from '../shared/live.js'
import type { LiveSource } from '../shared/live.js'
import { resolveWindowSource } from '../shared/window-source.js'

async function enumerateSources(thumbnails: boolean) {
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId().split(':').slice(0, 2).join(':')))
  const all = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: thumbnails ? { width: 240, height: 135 } : { width: 0, height: 0 } })
  return all.filter((s) => !own.has(s.id.split(':').slice(0, 2).join(':')))
}

// All output windows ask for the same inventory; one enumeration avoids overlapping native captures.
let inventory: ReturnType<typeof enumerateSources> | null = null
let inventoryAt = 0
async function sources(thumbnails: boolean) {
  if (thumbnails) return enumerateSources(true)
  if (!inventory || Date.now() - inventoryAt > 1000) {
    inventoryAt = Date.now()
    inventory = enumerateSources(false)
    inventory.catch(() => { inventory = null })
  }
  return inventory
}

export function registerWindowCapture(): void {
  ipcMain.handle('live:window-fps', (_event, requested?: number) => {
    const rates = screen.getAllDisplays().map(d => d.displayFrequency).filter(n => Number.isFinite(n) && n > 0)
    return Math.min(normalizeWindowFps(requested), ...(rates.length ? rates : [30]))
  })
  ipcMain.handle('live:list-windows', async () => {
    const all = await sources(true)
    return {
      sources: all.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() })),
      permission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
    }
  })
  ipcMain.handle('live:resolve-window', async (_event, src: LiveSource) => {
    if (src?.kind !== 'window' || typeof src.videoLabel !== 'string') throw new Error('Invalid window source')
    const found = resolveWindowSource(await sources(false), src.videoLabel, src.windowId)
    if (!found) throw new Error('Window unavailable or ambiguous')
    return found.id
  })
}
