const { app, BrowserWindow, dialog, ipcMain, desktopCapturer } = require("electron");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { execFile, spawn } = require("node:child_process");

const rendererUrl =
  process.env.ARENA_GOD_EYES_RENDERER_URL || "http://127.0.0.1:5173";
const backendUrl = process.env.ARENA_GOD_EYES_BACKEND_URL || "http://127.0.0.1:5188";

let backendProcess = null;
const recordingSessions = new Map();
const nativeRecordingSessions = new Map();
const ffmpegEncoderCache = new Map();
const obsSignalQueue = [];
const obsSignalWaiters = [];
const obsRuntimeState = {
  initialized: false,
  rootPath: null,
  osn: null,
  callbackAttached: false,
};

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

function getArenaCoachFfmpegCandidates() {
  return [
    "C:\\Program Files\\Games\\ArenaCoach\\resources\\app.asar.unpacked\\node_modules\\obs-studio-node\\ffmpeg.exe",
    "C:\\Program Files\\Games\\ArenaCoach\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe",
  ];
}

function getObsStudioNodeRootCandidates() {
  return [
    process.env.ARENA_GOD_EYES_OBS_NODE_PATH,
    "C:\\Program Files\\Games\\ArenaCoach\\resources\\app.asar.unpacked\\node_modules\\obs-studio-node",
  ].filter(Boolean);
}

function resolveFfmpegExecutable(preferredPath) {
  const candidates = [
    preferredPath,
    process.env.ARENA_GOD_EYES_FFMPEG_PATH,
    ...getArenaCoachFfmpegCandidates(),
    "ffmpeg",
  ].filter(Boolean);

  return candidates.find((candidate) => {
    if (!candidate) {
      return false;
    }

    if (candidate.toLowerCase() === "ffmpeg") {
      return true;
    }

    return fsSync.existsSync(candidate);
  }) ?? null;
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

async function resolveBestVideoEncoder(ffmpegPath) {
  if (ffmpegEncoderCache.has(ffmpegPath)) {
    return ffmpegEncoderCache.get(ffmpegPath);
  }

  let encoder = "libx264";
  try {
    const stdout = await runCommand(ffmpegPath, ["-hide_banner", "-encoders"]);
    if (stdout.includes("h264_nvenc")) {
      encoder = "h264_nvenc";
    } else if (stdout.includes("h264_amf")) {
      encoder = "h264_amf";
    } else if (stdout.includes("h264_qsv")) {
      encoder = "h264_qsv";
    }
  } catch {
    encoder = "libx264";
  }

  ffmpegEncoderCache.set(ffmpegPath, encoder);
  return encoder;
}

function buildEncoderArgs(encoder) {
  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "23", "-b:v", "0"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-global_quality", "23", "-look_ahead", "0"];
    default:
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];
  }
}

function buildNativeRecordingTarget(windowHandle, windowTitle) {
  if (windowHandle) {
    const hexHandle = Number(windowHandle).toString(16);
    return `hwnd=0x${hexHandle}`;
  }

  return `title=${windowTitle}`;
}

function queueObsSignal(signalInfo) {
  const waiter = obsSignalWaiters.shift();
  if (waiter) {
    waiter(signalInfo);
    return;
  }

  obsSignalQueue.push(signalInfo);
}

function resetObsSignalQueue() {
  obsSignalQueue.length = 0;
  obsSignalWaiters.length = 0;
}

function waitForObsSignal(predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const existingIndex = obsSignalQueue.findIndex(predicate);
    if (existingIndex >= 0) {
      const [signalInfo] = obsSignalQueue.splice(existingIndex, 1);
      resolve(signalInfo);
      return;
    }

    const timeout = setTimeout(() => {
      const waiterIndex = obsSignalWaiters.indexOf(handleSignal);
      if (waiterIndex >= 0) {
        obsSignalWaiters.splice(waiterIndex, 1);
      }

      reject(new Error("Timed out while waiting for OBS output signal."));
    }, timeoutMs);

    function handleSignal(signalInfo) {
      if (!predicate(signalInfo)) {
        obsSignalQueue.push(signalInfo);
        obsSignalWaiters.push(handleSignal);
        return;
      }

      clearTimeout(timeout);
      resolve(signalInfo);
    }

    obsSignalWaiters.push(handleSignal);
  });
}

function normalizeObsPath(candidatePath) {
  if (!candidatePath) {
    return null;
  }

  return candidatePath.replaceAll("/", path.sep);
}

function resolveObsStudioNodeRoot(preferredPath) {
  const candidates = [
    preferredPath,
    ...getObsStudioNodeRootCandidates(),
  ]
    .map(normalizeObsPath)
    .filter(Boolean);

  return candidates.find((candidate) => fsSync.existsSync(path.join(candidate, "package.json"))) ?? null;
}

function obsDataRootPath() {
  return path.join(app.getPath("userData"), "obs-runtime");
}

function getObsSettingContainers(osn, category) {
  return osn.NodeObs.OBS_settings_getSettings(category)?.data ?? [];
}

function setObsSetting(osn, category, parameter, value, subcategory = null) {
  let previousValue;
  let changed = false;
  const settings = getObsSettingContainers(osn, category);

  settings.forEach((group) => {
    if (subcategory && group.nameSubCategory !== subcategory) {
      return;
    }

    group.parameters.forEach((item) => {
      if (item.name !== parameter) {
        return;
      }

      previousValue = item.currentValue;
      if (item.currentValue !== value) {
        item.currentValue = value;
        changed = true;
      }
    });
  });

  if (changed && value !== previousValue) {
    osn.NodeObs.OBS_settings_saveSettings(category, settings);
  }
}

function getObsAvailableValues(osn, category, subcategory, parameter) {
  const groups = getObsSettingContainers(osn, category);
  const group = groups.find((item) => item.nameSubCategory === subcategory);
  const setting = group?.parameters?.find((item) => item.name === parameter);
  return setting?.values?.map((value) => Object.values(value)[0]) ?? [];
}

function chooseObsRecordingEncoder(availableEncoders) {
  const preferredEncoders = [
    "jim_nvenc",
    "ffmpeg_nvenc",
    "h264_texture_amf",
    "amd_amf_h264",
    "obs_qsv11_v2",
    "obs_qsv11",
    "x264",
  ];

  return preferredEncoders.find((encoder) => availableEncoders.includes(encoder)) ?? availableEncoders[0] ?? "x264";
}

function configureObsRecordingProfile(osn, directoryPath, targetExtension) {
  const availableEncoders = getObsAvailableValues(osn, "Output", "Recording", "RecEncoder");
  const encoder = chooseObsRecordingEncoder(availableEncoders);
  const normalizedExtension = (targetExtension || ".mp4").replace(/^\./, "").toLowerCase();

  setObsSetting(osn, "Output", "Mode", "Advanced");
  setObsSetting(osn, "Output", "RecEncoder", encoder, "Recording");
  setObsSetting(osn, "Output", "RecFilePath", directoryPath, "Recording");
  setObsSetting(osn, "Output", "RecFormat", normalizedExtension, "Recording");
  setObsSetting(osn, "Video", "FPSCommon", 60);
  setObsSetting(osn, "Video", "Base", "1920x1080");
  setObsSetting(osn, "Video", "Output", "1920x1080");
  return encoder;
}

function buildObsWindowDescriptor(windowTitle, windowClassName, executableName) {
  const safeTitle = windowTitle?.trim() || "World of Warcraft";
  const safeClass = windowClassName?.trim() || "GxWindowClass";
  const safeExecutable = executableName?.trim() || "Wow.exe";
  return `${safeTitle}:${safeClass}:${safeExecutable}`;
}

function buildObsSourceSettings(inputKind, windowDescriptor, captureCursor) {
  if (inputKind === "game_capture") {
    return {
      capture_mode: "window",
      window: windowDescriptor,
      capture_cursor: captureCursor,
    };
  }

  return {
    window: windowDescriptor,
    cursor: captureCursor,
  };
}

async function ensureObsRuntime(preferredRootPath) {
  if (obsRuntimeState.initialized && obsRuntimeState.osn) {
    return obsRuntimeState;
  }

  const rootPath = resolveObsStudioNodeRoot(preferredRootPath);
  if (!rootPath) {
    throw new Error("obs-studio-node runtime was not found. ArenaCoach-style capture is unavailable.");
  }

  const osn = require(rootPath);
  const dataRoot = obsDataRootPath();
  await fs.mkdir(dataRoot, { recursive: true });

  osn.NodeObs.IPC.host(`arena-god-eyes-${process.pid}`);
  osn.NodeObs.SetWorkingDirectory(rootPath);
  const initResult = osn.NodeObs.OBS_API_initAPI("en-US", dataRoot, app.getVersion());
  if (initResult !== 0) {
    throw new Error(`OBS runtime initialization failed with code ${initResult}.`);
  }

  osn.NodeObs.OBS_service_connectOutputSignals((signalInfo) => {
    queueObsSignal(signalInfo);
  });

  obsRuntimeState.initialized = true;
  obsRuntimeState.rootPath = rootPath;
  obsRuntimeState.osn = osn;
  obsRuntimeState.callbackAttached = true;
  return obsRuntimeState;
}

function cleanupObsGraph(session) {
  try {
    session?.inputSource?.release?.();
  } catch {
    // Ignore OBS source teardown issues during cleanup.
  }

  try {
    session?.scene?.release?.();
  } catch {
    // Ignore OBS scene teardown issues during cleanup.
  }
}

function createObsRecordingGraph(osn, sessionId, settings) {
  const sourceAttempts = [
    { inputKind: "game_capture", sourceName: `age-game-${sessionId}` },
    { inputKind: "window_capture", sourceName: `age-window-${sessionId}` },
  ];

  let lastError = null;
  for (const attempt of sourceAttempts) {
    try {
      const inputSource = osn.InputFactory.create(
        attempt.inputKind,
        attempt.sourceName,
        buildObsSourceSettings(attempt.inputKind, settings.windowDescriptor, settings.captureCursor),
      );
      const scene = osn.SceneFactory.create(`arena-god-eyes-${sessionId}`);
      scene.add(inputSource);
      osn.Global.setOutputSource(1, scene);
      return {
        inputKind: attempt.inputKind,
        inputSource,
        scene,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Unable to create an OBS capture source for the selected WoW window.");
}

async function startNativeRecording(payload) {
  const directoryPath = payload?.directoryPath;
  const fileName = payload?.fileName;
  const windowTitle = payload?.windowTitle;
  const windowClassName = payload?.windowClassName;
  const executableName = payload?.executableName;
  const captureCursor = payload?.captureCursor ?? false;

  if (!directoryPath || !fileName || !windowTitle) {
    throw new Error("directoryPath, fileName, and a WoW window target are required.");
  }

  if (nativeRecordingSessions.size > 0) {
    const existing = nativeRecordingSessions.values().next().value;
    return {
      sessionId: existing.sessionId,
      targetPath: existing.targetPath,
      ffmpegPath: null,
      encoder: existing.encoder,
      alreadyRunning: true,
    };
  }

  await fs.mkdir(directoryPath, { recursive: true });
  const runtime = await ensureObsRuntime(payload?.obsNodePath ?? null);
  const osn = runtime.osn;

  const sessionId = crypto.randomUUID();
  const targetPath = path.join(directoryPath, fileName);
  const encoder = configureObsRecordingProfile(osn, directoryPath, path.extname(fileName) || ".mp4");
  setObsSetting(osn, "Output", "FilenameFormatting", path.parse(fileName).name);
  let graph = null;
  try {
    graph = createObsRecordingGraph(osn, sessionId, {
      windowDescriptor: buildObsWindowDescriptor(windowTitle, windowClassName, executableName),
      captureCursor,
    });
    resetObsSignalQueue();
    osn.NodeObs.OBS_service_startRecording();
    const startSignal = await waitForObsSignal((signalInfo) => signalInfo?.type === "recording", 30000);
    if (String(startSignal?.signal || "").toLowerCase() === "stop") {
      throw new Error(startSignal?.error || "OBS refused to start recording.");
    }
  } catch (error) {
    cleanupObsGraph(graph);
    throw error;
  }

  const session = {
    sessionId,
    targetPath,
    encoder,
    graphKind: graph.inputKind,
    inputSource: graph.inputSource,
    scene: graph.scene,
  };

  nativeRecordingSessions.set(sessionId, session);

  return {
    sessionId,
    targetPath,
    ffmpegPath: null,
    encoder,
    inputKind: graph.inputKind,
    alreadyRunning: false,
  };
}

async function stopNativeRecording(payload) {
  const sessionId = payload?.sessionId;
  const finalFileName = payload?.finalFileName;
  if (!sessionId) {
    throw new Error("sessionId is required.");
  }

  const session = nativeRecordingSessions.get(sessionId);
  if (!session) {
    throw new Error("Native recording session not found.");
  }

  const osn = obsRuntimeState.osn;
  resetObsSignalQueue();
  osn.NodeObs.OBS_service_stopRecording();
  await waitForObsSignal((signalInfo) => signalInfo?.type === "recording" && String(signalInfo?.signal || "").toLowerCase() === "stop", 30000);
  nativeRecordingSessions.delete(sessionId);

  const lastRecording = osn.NodeObs.OBS_service_getLastRecording?.();
  let finalPath =
    (typeof lastRecording === "string" ? lastRecording : lastRecording?.path) ||
    session.targetPath;
  if (finalFileName) {
    const renamedPath = path.join(path.dirname(finalPath), finalFileName);
    if (renamedPath !== finalPath && fsSync.existsSync(finalPath)) {
      await fs.rename(finalPath, renamedPath);
      finalPath = renamedPath;
    }
  }

  cleanupObsGraph(session);
  const stats = fsSync.existsSync(finalPath) ? await fs.stat(finalPath) : null;
  return {
    path: finalPath,
    bytesWritten: stats?.size ?? 0,
    ffmpegPath: null,
    encoder: session.encoder,
    inputKind: session.graphKind,
  };
}

async function abortNativeRecording(payload) {
  const sessionId = payload?.sessionId;
  if (!sessionId) {
    return null;
  }

  const session = nativeRecordingSessions.get(sessionId);
  if (!session) {
    return null;
  }

  try {
    obsRuntimeState.osn?.NodeObs?.OBS_service_stopRecordingForce?.();
  } catch {
    // Ignore best-effort OBS teardown edge cases.
  }

  nativeRecordingSessions.delete(sessionId);
  cleanupObsGraph(session);
  try {
    await fs.unlink(session.targetPath);
  } catch {
    // Ignore missing or locked files during abort.
  }

  return null;
}

async function startRecordingSession(payload) {
  const directoryPath = payload?.directoryPath;
  const fileName = payload?.fileName;
  if (!directoryPath || !fileName) {
    throw new Error("directoryPath and fileName are required.");
  }

  await fs.mkdir(directoryPath, { recursive: true });

  const sessionId = crypto.randomUUID();
  const targetPath = path.join(directoryPath, fileName);
  const handle = await fs.open(targetPath, "w");
  recordingSessions.set(sessionId, {
    handle,
    targetPath,
    bytesWritten: 0,
  });

  return {
    sessionId,
    targetPath,
  };
}

async function appendRecordingChunk(payload) {
  const sessionId = payload?.sessionId;
  const arrayBuffer = payload?.arrayBuffer;
  if (!sessionId || !arrayBuffer) {
    throw new Error("sessionId and arrayBuffer are required.");
  }

  const session = recordingSessions.get(sessionId);
  if (!session) {
    throw new Error("Recording session not found.");
  }

  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength === 0) {
    return session.bytesWritten;
  }

  await session.handle.write(buffer, 0, buffer.byteLength, null);
  session.bytesWritten += buffer.byteLength;
  return session.bytesWritten;
}

async function finishRecordingSession(payload) {
  const sessionId = payload?.sessionId;
  const finalFileName = payload?.finalFileName;
  if (!sessionId) {
    throw new Error("sessionId is required.");
  }

  const session = recordingSessions.get(sessionId);
  if (!session) {
    throw new Error("Recording session not found.");
  }

  recordingSessions.delete(sessionId);
  await session.handle.close();

  let finalPath = session.targetPath;
  if (finalFileName) {
    const directoryPath = path.dirname(session.targetPath);
    const renamedPath = path.join(directoryPath, finalFileName);
    if (renamedPath !== session.targetPath) {
      await fs.rename(session.targetPath, renamedPath);
      finalPath = renamedPath;
    }
  }

  return {
    path: finalPath,
    bytesWritten: session.bytesWritten,
  };
}

async function abortRecordingSession(payload) {
  const sessionId = payload?.sessionId;
  if (!sessionId) {
    return null;
  }

  const session = recordingSessions.get(sessionId);
  if (!session) {
    return null;
  }

  recordingSessions.delete(sessionId);
  await session.handle.close();
  try {
    await fs.unlink(session.targetPath);
  } catch {
    // Keep the app resilient if Windows already removed or locked the file.
  }

  return null;
}

function workspaceRootPath() {
  return path.join(__dirname, "..", "..");
}

async function resolveDocAssetPath(relativeAssetPath) {
  if (!relativeAssetPath || typeof relativeAssetPath !== "string") {
    return null;
  }

  const docsAssetsRoot = path.join(workspaceRootPath(), "ArenaGodEyes.Docs", "src", "assets");
  const normalizedAssetPath = relativeAssetPath.replaceAll("/", path.sep);
  const candidatePath = path.resolve(docsAssetsRoot, normalizedAssetPath);
  const relativePath = path.relative(docsAssetsRoot, candidatePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  try {
    await fs.access(candidatePath);
    return candidatePath;
  } catch {
    return null;
  }
}

async function resolveSpellIcon(payload) {
  const spellId = Number(payload?.spellId);
  if (!Number.isInteger(spellId) || spellId <= 0) {
    return null;
  }

  const cacheRoot = path.join(app.getPath("userData"), "spell-icons");
  await fs.mkdir(cacheRoot, { recursive: true });

  const existingFiles = await fs.readdir(cacheRoot);
  const existingFile = existingFiles.find((fileName) => fileName.startsWith(`${spellId}_`));
  if (existingFile) {
    return path.join(cacheRoot, existingFile);
  }

  const tooltipResponse = await fetch(`https://www.wowhead.com/tooltip/spell/${spellId}?dataEnv=1&locale=enus`);
  if (!tooltipResponse.ok) {
    throw new Error(`Wowhead tooltip lookup failed for spell ${spellId}.`);
  }

  const tooltipBody = await tooltipResponse.text();
  const iconMatch =
    tooltipBody.match(/"icon"\s*:\s*"([^"]+)"/i) ??
    tooltipBody.match(/icon\s*:\s*'([^']+)'/i) ??
    tooltipBody.match(/icon:\s*"([^"]+)"/i);
  if (!iconMatch?.[1]) {
    return null;
  }

  const iconName = iconMatch[1].trim().toLowerCase();
  const iconUrl = `https://wow.zamimg.com/images/wow/icons/large/${iconName}.jpg`;
  const iconResponse = await fetch(iconUrl);
  if (!iconResponse.ok) {
    throw new Error(`Wowhead icon download failed for spell ${spellId}.`);
  }

  const buffer = Buffer.from(await iconResponse.arrayBuffer());
  const targetPath = path.join(cacheRoot, `${spellId}_${iconName}.jpg`);
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
  for (const session of recordingSessions.values()) {
    void session.handle.close().catch(() => undefined);
  }
  recordingSessions.clear();
  for (const session of nativeRecordingSessions.values()) {
    try {
      obsRuntimeState.osn?.NodeObs?.OBS_service_stopRecordingForce?.();
    } catch {
      // Ignore best-effort process shutdown.
    }

    cleanupObsGraph(session);
  }
  nativeRecordingSessions.clear();
  if (obsRuntimeState.callbackAttached) {
    try {
      obsRuntimeState.osn?.NodeObs?.OBS_service_removeCallback?.();
    } catch {
      // Ignore best-effort OBS callback teardown.
    }
  }
  try {
    obsRuntimeState.osn?.NodeObs?.IPC?.disconnect?.();
  } catch {
    // Ignore best-effort OBS IPC teardown.
  }
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
ipcMain.handle("desktop:start-recording-session", async (_event, payload) => startRecordingSession(payload));
ipcMain.handle("desktop:append-recording-chunk", async (_event, payload) => appendRecordingChunk(payload));
ipcMain.handle("desktop:finish-recording-session", async (_event, payload) => finishRecordingSession(payload));
ipcMain.handle("desktop:abort-recording-session", async (_event, payload) => abortRecordingSession(payload));
ipcMain.handle("desktop:start-native-recording", async (_event, payload) => startNativeRecording(payload));
ipcMain.handle("desktop:stop-native-recording", async (_event, payload) => stopNativeRecording(payload));
ipcMain.handle("desktop:abort-native-recording", async (_event, payload) => abortNativeRecording(payload));
ipcMain.handle("desktop:resolve-doc-asset-path", async (_event, relativeAssetPath) => resolveDocAssetPath(relativeAssetPath));
ipcMain.handle("desktop:resolve-spell-icon", async (_event, payload) => resolveSpellIcon(payload));

ipcMain.handle("desktop:ensure-obs-running", async () => ensureObsRunning());
