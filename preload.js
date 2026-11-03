'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну плеера доступно только это: поиск слов и распознавание слов нейросетью
contextBridge.exposeInMainWorld('lnApp', {
  findLyrics: (q) => ipcRenderer.invoke('lyrics:find', q),
  whisper: (q) => ipcRenderer.invoke('whisper:run', q),
  whisperCancel: () => ipcRenderer.invoke('whisper:cancel'),
  whisperReady: () => ipcRenderer.invoke('whisper:ready'),
  onWhisper: (fn) => ipcRenderer.on('whisper:progress', (_e, d) => fn(d)),
});
