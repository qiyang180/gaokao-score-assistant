const { contextBridge, ipcRenderer } = require('electron');

const subscriptions = new Set();

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  subscriptions.add(() => ipcRenderer.removeListener(channel, listener));
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('gaokao', {
  getDefaults: () => ipcRenderer.invoke('gaokao:get-defaults'),
  selectStudents: () => ipcRenderer.invoke('gaokao:select-students'),
  selectOutputDir: () => ipcRenderer.invoke('gaokao:select-output-dir'),
  previewStudents: (payload) => ipcRenderer.invoke('gaokao:preview-students', payload),
  startRun: (payload) => ipcRenderer.invoke('gaokao:start-run', payload),
  control: (payload) => ipcRenderer.invoke('gaokao:control', payload),
  openPath: (targetPath) => ipcRenderer.invoke('gaokao:open-path', targetPath),
  onRunStarted: (callback) => subscribe('gaokao:run-started', callback),
  onRunEvent: (callback) => subscribe('gaokao:run-event', callback),
  onLog: (callback) => subscribe('gaokao:log', callback),
  onRunClosed: (callback) => subscribe('gaokao:run-closed', callback),
  removeAllListeners: () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
    subscriptions.clear();
  },
});
