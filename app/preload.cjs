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
  getLicenseState: () => ipcRenderer.invoke('gaokao:get-license-state'),
  activateLicense: (payload) => ipcRenderer.invoke('gaokao:activate-license', payload),
  refreshLicense: () => ipcRenderer.invoke('gaokao:refresh-license'),
  exportOfflineRequest: () => ipcRenderer.invoke('gaokao:export-offline-request'),
  importOfflineLicense: () => ipcRenderer.invoke('gaokao:import-offline-license'),
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
