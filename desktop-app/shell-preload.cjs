const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  getState: () => ipcRenderer.invoke('vynzosocial:shell:state'),
  action: (type, section) => ipcRenderer.invoke('vynzosocial:shell:action', type, section),
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('A desktop state callback is required.');
    const listener = (event, state) => callback(state);
    ipcRenderer.on('vynzosocial:shell:changed', listener);
    return () => ipcRenderer.removeListener('vynzosocial:shell:changed', listener);
  }
});
