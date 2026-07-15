import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PresenterApi } from './api'

const api: PresenterApi = {
  state: {
    get: () => ipcRenderer.invoke('state:get'),
    onPatch: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, patch: object) => cb(patch as never)
      ipcRenderer.on('state:patch', listener)
      return () => ipcRenderer.removeListener('state:patch', listener)
    },
    onFull: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, full: object) => cb(full as never)
      ipcRenderer.on('state:full', listener)
      return () => ipcRenderer.removeListener('state:full', listener)
    },
  },
  pdf: {
    openDialog: () => ipcRenderer.invoke('pdf:open-dialog'),
    openPath: (path) => ipcRenderer.invoke('pdf:open-path', path),
    read: () => ipcRenderer.invoke('pdf:read'),
    reportTotal: (total) => ipcRenderer.invoke('pdf:report-total', total),
  },
  nav: {
    goto: (slide) => ipcRenderer.invoke('nav:goto', slide),
    next: () => ipcRenderer.invoke('nav:next'),
    prev: () => ipcRenderer.invoke('nav:prev'),
  },
  clicker: {
    setGlobal: (value) => ipcRenderer.invoke('clicker:set-global', Boolean(value)),
    setGlobalArrows: (value) => ipcRenderer.invoke('clicker:set-global-arrows', Boolean(value)),
  },
  preview: {
    openDialog: () => ipcRenderer.invoke('preview:open-dialog'),
    openPath: (path) => ipcRenderer.invoke('preview:open-path', path),
    read: () => ipcRenderer.invoke('preview:read'),
    reportTotal: (total) => ipcRenderer.invoke('preview:report-total', total),
    goto: (slide) => ipcRenderer.invoke('preview:goto', slide),
    next: () => ipcRenderer.invoke('preview:next'),
    prev: () => ipcRenderer.invoke('preview:prev'),
    clear: () => ipcRenderer.invoke('preview:clear'),
    take: () => ipcRenderer.invoke('preview:take'),
    setVideoTakeMode: (mode) => ipcRenderer.invoke('preview:set-video-take-mode', mode),
    setSlideTakeMode: (mode) => ipcRenderer.invoke('preview:set-slide-take-mode', mode),
    video: {
      toggle: () => ipcRenderer.invoke('preview:video:toggle'),
      seek: (sec) => ipcRenderer.invoke('preview:video:seek', sec),
      seekBy: (deltaSec) => ipcRenderer.invoke('preview:video:seek-by', deltaSec),
      setDuration: (sec) => ipcRenderer.invoke('preview:video:set-duration', sec),
      ended: () => ipcRenderer.invoke('preview:video:ended'),
    },
  },
  note: {
    update: (slide, text) => ipcRenderer.invoke('note:update', { slide, text }),
    setFontSize: (px) => ipcRenderer.invoke('notes:set-font-size', px),
  },
  timer: {
    start: () => ipcRenderer.invoke('timer:start'),
    pause: () => ipcRenderer.invoke('timer:pause'),
    reset: () => ipcRenderer.invoke('timer:reset'),
    setDuration: (ms) => ipcRenderer.invoke('timer:set-duration', ms),
    adjust: (deltaMs) => ipcRenderer.invoke('timer:adjust', deltaMs),
    setMode: (mode) => ipcRenderer.invoke('timer:set-mode', mode),
    setPosition: (pos) => ipcRenderer.invoke('timer:set-position', pos),
    setScale: (scale) => ipcRenderer.invoke('timer:set-scale', scale),
    setTickSound: (enabled) => ipcRenderer.invoke('timer:set-tick-sound', enabled),
    setGongSound: (enabled) => ipcRenderer.invoke('timer:set-gong-sound', enabled),
    setLoop: (enabled) => ipcRenderer.invoke('timer:set-loop', enabled),
    setPresets: (presets) => ipcRenderer.invoke('timer:set-presets', presets),
  },
  blackout: {
    toggle: () => ipcRenderer.invoke('blackout:toggle'),
  },
  speakerMessage: {
    set: (text) => ipcRenderer.invoke('speaker-message:set', text),
    setPresets: (presets) => ipcRenderer.invoke('speaker-message:set-presets', presets),
  },
  video: {
    play: () => ipcRenderer.invoke('video:play'),
    pause: () => ipcRenderer.invoke('video:pause'),
    toggle: () => ipcRenderer.invoke('video:toggle'),
    seek: (sec) => ipcRenderer.invoke('video:seek', sec),
    seekBy: (deltaSec) => ipcRenderer.invoke('video:seek-by', deltaSec),
    setDuration: (sec) => ipcRenderer.invoke('video:set-duration', sec),
    ended: () => ipcRenderer.invoke('video:ended'),
    setMuted: (muted) => ipcRenderer.invoke('video:set-muted', muted),
    toggleMuted: () => ipcRenderer.invoke('video:toggle-muted'),
  },
  audio: {
    setOutput: (deviceId) => ipcRenderer.invoke('audio:set-output', deviceId),
  },
  displays: {
    list: () => ipcRenderer.invoke('displays:list'),
  },
  layout: {
    set: (layout, displayMap, audienceWindowed) => ipcRenderer.invoke('layout:set', { layout, displayMap, audienceWindowed: Boolean(audienceWindowed) }),
    getAskOnStartup: () => ipcRenderer.invoke('layout:get-ask-on-startup'),
    setAskOnStartup: (value) => ipcRenderer.invoke('layout:set-ask-on-startup', Boolean(value)),
  },
  monitor: {
    setEnabled: (value) => ipcRenderer.invoke('monitor:set-enabled', Boolean(value)),
    onFrame: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, frame: { role: 'speaker' | 'audience'; dataUrl: string }) => cb(frame)
      ipcRenderer.on('monitor:frame', listener)
      return () => ipcRenderer.removeListener('monitor:frame', listener)
    },
  },
  ui: {
    setTheme: (theme) => ipcRenderer.invoke('ui:set-theme', theme),
  },
  files: {
    // Sandboxed renderer has no File.path (removed in Electron 32) — this is
    // the only way to resolve a dropped File to its filesystem path.
    pathFor: (file) => webUtils.getPathForFile(file),
  },
  playlist: {
    add: () => ipcRenderer.invoke('playlist:add'),
    addPaths: (paths) => ipcRenderer.invoke('playlist:add-paths', paths),
    remove: (id) => ipcRenderer.invoke('playlist:remove', id),
    reorder: (ids) => ipcRenderer.invoke('playlist:reorder', ids),
    update: (id, payload) => ipcRenderer.invoke('playlist:update', { id, ...payload }),
    activate: (id) => ipcRenderer.invoke('playlist:activate', id),
    activateLive: (id) => ipcRenderer.invoke('playlist:activate-live', id),
    setCompact: (value) => ipcRenderer.invoke('playlist:set-compact', value),
    setAutoAdvance: (value) => ipcRenderer.invoke('playlist:set-auto-advance', value),
  },
  keyvisual: {
    set: () => ipcRenderer.invoke('keyvisual:set'),
    clear: () => ipcRenderer.invoke('keyvisual:clear'),
    read: () => ipcRenderer.invoke('keyvisual:read'),
  },
  project: {
    create: () => ipcRenderer.invoke('project:new'),
    save: (saveAs) => ipcRenderer.invoke('project:save', { saveAs: Boolean(saveAs) }),
    open: () => ipcRenderer.invoke('project:open'),
  },
  menu: {
    onOpenPdf: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('menu:open-pdf', listener)
      return () => ipcRenderer.removeListener('menu:open-pdf', listener)
    },
    onOpenDisplaySetup: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('menu:open-display-setup', listener)
      return () => ipcRenderer.removeListener('menu:open-display-setup', listener)
    },
    onTopologyChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('display:topology-changed', listener)
      return () => ipcRenderer.removeListener('display:topology-changed', listener)
    },
    onProjectNew: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('menu:project-new', listener)
      return () => ipcRenderer.removeListener('menu:project-new', listener)
    },
    onProjectOpen: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('menu:project-open', listener)
      return () => ipcRenderer.removeListener('menu:project-open', listener)
    },
    onProjectSave: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('menu:project-save', listener)
      return () => ipcRenderer.removeListener('menu:project-save', listener)
    },
    onProjectSaveAs: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('menu:project-save-as', listener)
      return () => ipcRenderer.removeListener('menu:project-save-as', listener)
    },
    onHelp: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('menu:help', listener)
      return () => ipcRenderer.removeListener('menu:help', listener)
    },
  },
  update: {
    onAvailable: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, info: { newerVersion: string; url: string }) =>
        cb(info)
      ipcRenderer.on('update:available', listener)
      return () => ipcRenderer.removeListener('update:available', listener)
    },
  },
  session: {
    hasLast: () => ipcRenderer.invoke('session:has-last'),
    restore: () => ipcRenderer.invoke('session:restore'),
  },
  soffice: {
    check: () => ipcRenderer.invoke('soffice:check'),
  },
  external: {
    open: (url) => ipcRenderer.invoke('external:open', url),
  },
}

contextBridge.exposeInMainWorld('api', api)
