import { contextBridge, ipcRenderer } from 'electron'
import type { PdfOwnerCommand, PdfOwnerReply } from '../shared/pdf-frames'
ipcRenderer.on('pdf-owner:port', (event, metadata) => {
  window.postMessage({ type: 'cuedeck-pdf-owner-port', metadata }, '*', event.ports)
})
contextBridge.exposeInMainWorld('pdfOwner', {
  ready: () => ipcRenderer.send('pdf-owner:ready'),
  reply: (reply: PdfOwnerReply) => ipcRenderer.send('pdf-owner:reply', reply),
  onCommand: (callback: (command: PdfOwnerCommand) => void) => {
    ipcRenderer.on('pdf-owner:command', (_event, command) => callback(command))
  },
})
