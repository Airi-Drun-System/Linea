'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну плеера доступно только это: поиск слов, минус, оверлей и клавиши
contextBridge.exposeInMainWorld('lnApp', {
  findLyrics: (q) => ipcRenderer.invoke('lyrics:find', q),
  log: (m) => ipcRenderer.send('log', m),
  win: (a) => ipcRenderer.send('win:act', a),
  prefs: (q) => ipcRenderer.send('app:prefs', q),
  updState: () => ipcRenderer.invoke('upd:state'),
  updCheck: () => ipcRenderer.invoke('upd:check'),
  updInstall: () => ipcRenderer.send('upd:install'),
  onUpd: (fn) => ipcRenderer.on('upd:ready', (_e, v) => fn(v)),
  globalKeys: (on) => ipcRenderer.invoke('keys:global', on),
  onStep: (fn) => ipcRenderer.on('keys:step', (_e, d) => fn(d)),
  overlay: (q) => ipcRenderer.invoke('overlay:set', q),
  overlayState: (st) => ipcRenderer.send('overlay:state', st),
  separate: (q) => ipcRenderer.invoke('sep:run', q),
  sepCancel: () => ipcRenderer.invoke('sep:cancel'),
  sepReady: () => ipcRenderer.invoke('sep:ready'),
  onSep: (fn) => ipcRenderer.on('sep:progress', (_e, d) => fn(d)),
  bridgeUrl: () => ipcRenderer.invoke('net:port').then((p) => `http://127.0.0.1:${p}/player.html`),
  oembed: (kind, url) => ipcRenderer.invoke('net:oembed', kind, url),
  netImg: (url) => ipcRenderer.invoke('net:img', url),
  netFile: (url) => ipcRenderer.invoke('net:file', url),
  netFinal: (url) => ipcRenderer.invoke('net:final', url),
  browse: (site) => ipcRenderer.send('browse:open', site),
  onNetAdd: (fn) => ipcRenderer.on('net:add', (_e, url) => fn(url)),
});
