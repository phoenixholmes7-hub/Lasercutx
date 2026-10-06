// Exposes a minimal, safe file API to the editor (window.lcx).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcx', {
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveFiles: (opts) => ipcRenderer.invoke('save-files', opts),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
});
