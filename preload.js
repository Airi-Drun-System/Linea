'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну плеера доступно только одно: поиск слов песни
contextBridge.exposeInMainWorld('lnApp', {
  findLyrics: (q) => ipcRenderer.invoke('lyrics:find', q),
});
