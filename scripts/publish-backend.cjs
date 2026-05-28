const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runtime = process.argv[2];

if (!runtime) {
  console.error("Usage: node scripts/publish-backend.cjs <rid>");
  process.exit(1);
}

const desktopRoot = path.resolve(__dirname, "..");
const backendProject = path.resolve(
  desktopRoot,
  "..",
  "ArenaGodEyes.Backend",
  "src",
  "ArenaGodEyes.ApiLocal",
  "ArenaGodEyes.ApiLocal.csproj",
);
const outputDirectory = path.resolve(desktopRoot, "resources", "backend");

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync(
  "dotnet",
  [
    "publish",
    backendProject,
    "-c",
    "Release",
    "-r",
    runtime,
    "--self-contained",
    "true",
    "-o",
    outputDirectory,
  ],
  {
    cwd: path.resolve(desktopRoot, ".."),
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
