import { contextBridge, ipcRenderer } from 'electron'
ipcRenderer.on('render-qa:port', (event, info) => {
  window.postMessage({ kind: 'render-qa:port', info }, '*', event.ports)
})
contextBridge.exposeInMainWorld('renderQA', {
  config: () => ipcRenderer.invoke('render-qa:config'),
  ready: () => ipcRenderer.send('render-qa:ready'),
})
