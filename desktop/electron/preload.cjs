const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('nimbus', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onState: (callback) => on('window:state', callback),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    onOpenChannel: (callback) => on('app:open-channel', callback),
    onDeepLink: (callback) => on('app:deeplink', callback),
  },
  screen: {
    sources: () => ipcRenderer.invoke('screen:sources'),
    select: (sourceId) => ipcRenderer.invoke('screen:select', sourceId),
    cancel: () => ipcRenderer.invoke('screen:cancel'),
  },
  notify: (payload) => ipcRenderer.send('notify', payload),
  setBadge: (count) => ipcRenderer.send('badge', count),
  flash: () => ipcRenderer.send('flash'),
});
