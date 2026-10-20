// 화면 쪽에 꼭 필요한 기능만 안전하게 열어 주는 연결 통로
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskcal', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getEvents: (from, to, force) => ipcRenderer.invoke('events:get', { from, to, force: !!force }),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  icloudConnect: (appleId, password) => ipcRenderer.invoke('icloud:connect', { appleId, password }),
  icloudDisconnect: () => ipcRenderer.invoke('icloud:disconnect'),
  icloudUpdate: (patch) => ipcRenderer.invoke('icloud:update', patch),
  googleLogin: () => ipcRenderer.invoke('google:login'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  googleUpdate: (patch) => ipcRenderer.invoke('google:update', patch),
  setDefaultCal: (key) => ipcRenderer.invoke('cal:set-default', key),
  createEvent: (calUrl, event) => ipcRenderer.invoke('event:create', { calUrl, event }),
  updateEvent: (objUrl, uid, event) => ipcRenderer.invoke('event:update', { objUrl, uid, event }),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  deleteEvent: (objUrl, etag) => ipcRenderer.invoke('event:delete', { objUrl, etag }),
  arrange: (on) => ipcRenderer.invoke('win:arrange', on),
  getSize: () => ipcRenderer.invoke('win:get-size'),
  resizeTo: (width, height) => ipcRenderer.send('win:resize', { width, height }),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  on: (channel, fn) => {
    if (['open-settings', 'refresh', 'config-changed', 'start-arrange'].includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => fn(data));
    }
  },
});
