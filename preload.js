'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну плеера доступно только это: поиск слов и распознавание слов нейросетью
contextBridge.exposeInMainWorld('lnApp', {
  findLyrics: (q) => ipcRenderer.invoke('lyrics:find', q),
  whisper: (q) => ipcRenderer.invoke('whisper:run', q),
  whisperCancel: () => ipcRenderer.invoke('whisper:cancel'),
  whisperReady: () => ipcRenderer.invoke('whisper:ready'),
  onWhisper: (fn) => ipcRenderer.on('whisper:progress', (_e, d) => fn(d)),
  globalKeys: (on) => ipcRenderer.invoke('keys:global', on),
  onStep: (fn) => ipcRenderer.on('keys:step', (_e, d) => fn(d)),
  overlay: (q) => ipcRenderer.invoke('overlay:set', q),
  overlayState: (st) => ipcRenderer.send('overlay:state', st),
  separate: (q) => ipcRenderer.invoke('sep:run', q),
  sepCancel: () => ipcRenderer.invoke('sep:cancel'),
  sepReady: () => ipcRenderer.invoke('sep:ready'),
  onSep: (fn) => ipcRenderer.on('sep:progress', (_e, d) => fn(d)),
});
