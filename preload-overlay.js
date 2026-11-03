'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// оверлею нужно только получать строку и знать, двигают ли его
contextBridge.exposeInMainWorld('ov', {
  onState: (fn) => ipcRenderer.on('overlay:state', (_e, st) => fn(st)),
  onMove: (fn) => ipcRenderer.on('overlay:move', (_e, m) => fn(m)),
});
