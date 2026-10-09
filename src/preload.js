const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg);
const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('clipdeck', {
  scan: call('library:scan'),
  addFolder: call('folders:add'),
  removeFolder: call('folders:remove'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  forgetLogin: call('settings:forget'),
  reveal: call('clip:reveal'),
  copyFile: call('clip:copyFile'),
  trash: call('clip:trash'),
  copyText: call('text:copy'),
  openLink: call('link:open'),
  exportClip: call('export:run'),
  uploadStreamable: call('upload:streamable'),
  uploadYouTube: call('upload:youtube'),
  onClipUpdate: on('clip:update'),
  onLibraryChanged: on('library:changed'),
  onJobProgress: on('job:progress'),
});
