// Exposes a minimal, safe file API to the editor (window.lcx).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcx', {
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveFiles: (opts) => ipcRenderer.invoke('save-files', opts),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  userName: ipcRenderer.sendSync('user-name'),
  secret: {
    get: (name) => ipcRenderer.invoke('secret-get', name),
    set: (name, value) => ipcRenderer.invoke('secret-set', name, value),
  },
});
