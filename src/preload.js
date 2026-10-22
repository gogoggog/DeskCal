// 화면 쪽에 꼭 필요한 기능만 안전하게 열어 주는 연결 통로
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskcal', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getEvents: (from, to, force) => ipcRenderer.invoke('events:get', { from, to, force: !!force }),
  search: (query, force) => ipcRenderer.invoke('events:search', { query, force: !!force }),
  searchWarm: () => ipcRenderer.invoke('events:search-warm'),
  memoGet: (month) => ipcRenderer.invoke('memo:get', month),
  memoSync: (month) => ipcRenderer.invoke('memo:sync', month),
  memoSet: (month, text) => ipcRenderer.invoke('memo:set', { month, text }),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  macRequest: () => ipcRenderer.invoke('mac:request'),
  macUpdate: (patch) => ipcRenderer.invoke('mac:update', patch),
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
  updateGet: () => ipcRenderer.invoke('update:get'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  arrange: (on) => ipcRenderer.invoke('win:arrange', on),
  getSize: () => ipcRenderer.invoke('win:get-size'),
  resizeTo: (width, height) => ipcRenderer.send('win:resize', { width, height }),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  on: (channel, fn) => {
    if (['open-settings', 'refresh', 'config-changed', 'start-arrange', 'update-state', 'open-search'].includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => fn(data));
    }
  },
});
