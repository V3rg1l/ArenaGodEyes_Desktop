const { app, BrowserWindow, dialog, ipcMain, desktopCapturer } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile, spawn } = require("node:child_process");

const rendererUrl =
  process.env.ARENA_GOD_EYES_RENDERER_URL || "http://127.0.0.1:5173";
const backendUrl = process.env.ARENA_GOD_EYES_BACKEND_URL || "http://127.0.0.1:5188";

let backendProcess = null;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function runPowerShellJson(script) {
  const stdout = await runCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);

  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  return JSON.parse(trimmed);
}

async function tryRunPowerShellJson(script, fallbackValue) {
  try {
    return await runPowerShellJson(script);
  } catch {
    return fallbackValue;
  }
}

function getObsExecutableCandidates() {
  return [
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "obs-studio", "bin", "64bit", "obs64.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "obs-studio", "bin", "64bit", "obs64.exe"),
  ];
}

async function listWowWindows() {
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ArenaGodEyesWin32 {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
}
"@
$wowProcessRows = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(Wow|WowClassic|WowClassicEra|WowB)(64)?\.exe$' -or
  ($_.ExecutablePath -and $_.ExecutablePath -like '*World of Warcraft*')
} | Select-Object ProcessId, Name, ExecutablePath
$wowProcessLookup = @{}
foreach ($row in $wowProcessRows) {
  $wowProcessLookup[[int]$row.ProcessId] = $row
}
$processes = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    $wowProcessLookup.ContainsKey([int]$_.Id) -or
    $_.ProcessName -match '^(wow|wowclassic|wowclassicera|wowb)(64)?$'
  )
}
$result = foreach ($process in $processes) {
  if (-not [ArenaGodEyesWin32]::IsWindowVisible($process.MainWindowHandle)) { continue }
  $titleBuilder = New-Object System.Text.StringBuilder 1024
  [void][ArenaGodEyesWin32]::GetWindowText($process.MainWindowHandle, $titleBuilder, $titleBuilder.Capacity)
  $classBuilder = New-Object System.Text.StringBuilder 512
  [void][ArenaGodEyesWin32]::GetClassName($process.MainWindowHandle, $classBuilder, $classBuilder.Capacity)
  $lookup = $wowProcessLookup[[int]$process.Id]
  $executablePath = if ($lookup) { $lookup.ExecutablePath } else { $null }
  $executableName = if ($lookup -and $lookup.Name) { $lookup.Name } elseif ($executablePath) { [System.IO.Path]::GetFileName($executablePath) } else { $null }
  $windowTitle = $titleBuilder.ToString()
  if ([string]::IsNullOrWhiteSpace($windowTitle)) { continue }
  [pscustomobject]@{
    handle = [int64]$process.MainWindowHandle
    processId = $process.Id
    processName = $process.ProcessName
    title = $windowTitle
    className = $classBuilder.ToString()
    executablePath = $executablePath
    executableName = $executableName
  }
}
$result | ConvertTo-Json -Depth 4
`;

  const result = await tryRunPowerShellJson(script, []);
  return Array.isArray(result) ? result.filter((item) => item && item.title) : result ? [result] : [];
}

async function ensureObsRunning() {
  const existingObs = await tryRunPowerShellJson(`
$obs = Get-Process obs64 -ErrorAction SilentlyContinue | Select-Object -First 1 Id, ProcessName
if ($obs) { $obs | ConvertTo-Json -Depth 3 }
`, null);

  if (existingObs && !Array.isArray(existingObs)) {
    return { detected: true, launched: false, path: null, errorMessage: null };
  }

  return {
    detected: false,
    launched: false,
    path: getObsExecutableCandidates()[0],
    errorMessage: "OBS is not running.",
  };
}

async function listCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id || null,
  }));
}

async function saveRecordingBuffer(payload) {
  const directoryPath = payload?.directoryPath;
  const fileName = payload?.fileName;
  const arrayBuffer = payload?.arrayBuffer;

  if (!directoryPath || !fileName || !arrayBuffer) {
    throw new Error("directoryPath, fileName, and arrayBuffer are required.");
  }

  await fs.mkdir(directoryPath, { recursive: true });

  const targetPath = path.join(directoryPath, fileName);
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}

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

ipcMain.handle("desktop:list-wow-windows", async () => listWowWindows());
ipcMain.handle("desktop:list-capture-sources", async () => listCaptureSources());
ipcMain.handle("desktop:save-recording-buffer", async (_event, payload) => saveRecordingBuffer(payload));

ipcMain.handle("desktop:ensure-obs-running", async () => ensureObsRunning());
