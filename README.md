# ArenaGodEyes.Desktop

This project group is reserved for the Electron desktop shell.

## Role

- package the product as an installable desktop application
- host the React + Vite UI
- communicate with the local .NET backend
- own desktop-specific settings and packaging flows
- expose safe local dialogs and file actions to the UI
- bootstrap and host the local workflow end to end

## Important Rule

The user should open ArenaGodEyes as a local desktop app and should not need a browser in production.

## Current State

The current desktop shell already:

- starts the backend with `dotnet run`
- opens the UI in Electron
- exposes safe file and directory pickers
- supports a packaged-mode backend path via `resources/backend`

## Next Step

- validate full publish/package flow on macOS and Windows
- keep the shell aligned with the backend/video workflow as richer metrics land
