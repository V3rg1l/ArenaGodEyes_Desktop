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

## Backend Publish Commands

macOS:

```powershell
cd ArenaGodEyes.Desktop
npm run publish:backend:mac
```

Windows:

```powershell
cd ArenaGodEyes.Desktop
npm run publish:backend:win
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
- `npm run package:full:mac`
- `npm run package:full:win`

## Important Note

The `package:full:*` commands publish the backend first and then package Electron.
