const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kaset', {
  onTrack: (cb) => ipcRenderer.on('track', (_event, data) => cb(data)),
  onLyrics: (cb) => ipcRenderer.on('lyrics', (_event, data) => cb(data)),
  onPalette: (cb) => ipcRenderer.on('palette', (_event, data) => cb(data)),
  close: () => ipcRenderer.send('close-app'),
});
