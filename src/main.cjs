const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rendererUrl =
  process.env.ARENA_GOD_EYES_RENDERER_URL || "http://127.0.0.1:5173";
const backendUrl = process.env.ARENA_GOD_EYES_BACKEND_URL || "http://127.0.0.1:5188";

let backendProcess = null;

function isPackagedApp() {
  return app.isPackaged;
}

function backendProjectPath() {
  return path.join(
    __dirname,
    "..",
    "..",
    "ArenaGodEyes.Backend",
    "src",
    "ArenaGodEyes.ApiLocal",
    "ArenaGodEyes.ApiLocal.csproj",
  );
}

function packagedBackendRoot() {
  return path.join(process.resourcesPath, "backend");
}

function packagedBackendExecutablePath() {
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.join(packagedBackendRoot(), `ArenaGodEyes.ApiLocal${extension}`);
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
    backgroundColor: "#0d1012",
    title: "ArenaGodEyes",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(rendererUrl);
}

function startBackend() {
  if (backendProcess) {
    return;
  }

  const spawnConfig = isPackagedApp()
    ? {
        command: packagedBackendExecutablePath(),
        args: ["--urls", backendUrl],
        cwd: packagedBackendRoot(),
      }
    : {
        command: "dotnet",
        args: [
          "run",
          "--project",
          backendProjectPath(),
          "--urls",
          backendUrl,
        ],
        cwd: path.join(__dirname, "..", ".."),
      };

  backendProcess = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: spawnConfig.cwd,
    windowsHide: true,
    stdio: "ignore",
  });

  backendProcess.on("exit", () => {
    backendProcess = null;
  });
}

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});

ipcMain.handle("desktop:select-combat-log-file", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select a combat log or chunk file",
    properties: ["openFile"],
    filters: [
      { name: "Combat logs", extensions: ["txt", "log"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("desktop:select-video-file", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select a local match video",
    properties: ["openFile"],
    filters: [
      { name: "Video files", extensions: ["mp4", "mkv", "mov", "webm"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("desktop:select-directory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select a folder",
    properties: ["openDirectory"],
  });

  return result.canceled ? null : result.filePaths[0];
});
