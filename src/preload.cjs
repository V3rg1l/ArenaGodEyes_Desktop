const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("arenaGodEyesDesktop", {
  isDesktop: true,
  selectCombatLogFile: () => ipcRenderer.invoke("desktop:select-combat-log-file"),
  selectVideoFile: () => ipcRenderer.invoke("desktop:select-video-file"),
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
});
