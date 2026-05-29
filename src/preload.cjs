const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("arenaGodEyesDesktop", {
  isDesktop: true,
  selectCombatLogFile: () => ipcRenderer.invoke("desktop:select-combat-log-file"),
  selectVideoFile: () => ipcRenderer.invoke("desktop:select-video-file"),
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
  listWowWindows: () => ipcRenderer.invoke("desktop:list-wow-windows"),
  listCaptureSources: () => ipcRenderer.invoke("desktop:list-capture-sources"),
  saveRecordingBuffer: (payload) => ipcRenderer.invoke("desktop:save-recording-buffer", payload),
  startRecordingSession: (payload) => ipcRenderer.invoke("desktop:start-recording-session", payload),
  appendRecordingChunk: (payload) => ipcRenderer.invoke("desktop:append-recording-chunk", payload),
  finishRecordingSession: (payload) => ipcRenderer.invoke("desktop:finish-recording-session", payload),
  abortRecordingSession: (payload) => ipcRenderer.invoke("desktop:abort-recording-session", payload),
  startNativeRecording: (payload) => ipcRenderer.invoke("desktop:start-native-recording", payload),
  stopNativeRecording: (payload) => ipcRenderer.invoke("desktop:stop-native-recording", payload),
  abortNativeRecording: (payload) => ipcRenderer.invoke("desktop:abort-native-recording", payload),
  resolveDocAssetPath: (relativeAssetPath) => ipcRenderer.invoke("desktop:resolve-doc-asset-path", relativeAssetPath),
  resolveSpellIcon: (payload) => ipcRenderer.invoke("desktop:resolve-spell-icon", payload),
  ensureObsRunning: () => ipcRenderer.invoke("desktop:ensure-obs-running"),
});
