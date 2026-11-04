'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну плеера доступно только это: поиск слов, минус, оверлей и клавиши
contextBridge.exposeInMainWorld('lnApp', {
  findLyrics: (q) => ipcRenderer.invoke('lyrics:find', q),
  log: (m) => ipcRenderer.send('log', m),
  win: (a) => ipcRenderer.send('win:act', a),
  globalKeys: (on) => ipcRenderer.invoke('keys:global', on),
  onStep: (fn) => ipcRenderer.on('keys:step', (_e, d) => fn(d)),
  overlay: (q) => ipcRenderer.invoke('overlay:set', q),
  overlayState: (st) => ipcRenderer.send('overlay:state', st),
  separate: (q) => ipcRenderer.invoke('sep:run', q),
  sepCancel: () => ipcRenderer.invoke('sep:cancel'),
  sepReady: () => ipcRenderer.invoke('sep:ready'),
  onSep: (fn) => ipcRenderer.on('sep:progress', (_e, d) => fn(d)),
});
