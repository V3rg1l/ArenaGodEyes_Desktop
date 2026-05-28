# ArenaGodEyes Desktop Packaging

This desktop shell now supports two execution modes:

- development
  - Electron starts the backend with `dotnet run`
- packaged app
  - Electron starts a published backend binary from `resources/backend`

## Expected Packaging Flow

1. publish the backend into `ArenaGodEyes.Desktop/resources/backend`
2. package the Electron app
3. run the packaged desktop app, which boots the local backend binary automatically

## Backend Publish Examples

macOS:

```powershell
cd ArenaGodEyes.Backend
dotnet publish src/ArenaGodEyes.ApiLocal -c Release -r osx-arm64 --self-contained true -o ../ArenaGodEyes.Desktop/resources/backend
```

Windows:

```powershell
cd ArenaGodEyes.Backend
dotnet publish src/ArenaGodEyes.ApiLocal -c Release -r win-x64 --self-contained true -o ../ArenaGodEyes.Desktop/resources/backend
```

## Electron Packaging Commands

```powershell
cd ArenaGodEyes.Desktop
npm install
npm run package:dir
```

Platform targets:

- `npm run package:mac`
- `npm run package:win`

## Important Note

The packaged app expects the published backend executable to exist inside `resources/backend` before packaging.
