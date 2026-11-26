# main

The Electron main process. Thin: it owns the window and the OS-facing pieces, validates every IPC argument, and hands the work to `core/`.

| Entry | What it does |
|---|---|
| `index.ts` | Creates the window; registers an `ipcMain.handle` per `Channel` that calls `ProjectRegistry` / `Workspace`; validates arguments (`str`, `int`, `status`), treating the renderer as untrusted; runs one recursive file watcher per open workspace; native folder picker and confirm dialogs; locates the user's `claude` binary and picks the thread agent (`MANTA_FAKE_AGENT=1` for the scripted one); opens the `TerminalManager` (the user's login shell env, `claude` or `scripts/fake-claude.mjs` under `MANTA_FAKE_AGENT=1`), forwards terminal output and changes, asks before closing a busy Claude session, and closes a worktree's terminals before removing it; context maps (`docsMaps` refuses any root but the docs repo, a native dialog before removing one, `MapSessions`, and a scripted map agent under `MANTA_FAKE_AGENT=1`); `MANTA_USER_DATA` for an isolated instance. |

**Imports:** `../core/agent/`, `../core/repo/`, `../core/terminal/`, `../shared/ipc.ts`. Workspaces are reached through `ProjectRegistry.workspace(root)`, which also checks the root is one the user added.

**Adding an IPC call:** add it to `MantaApi` and `Channel` in `../shared/ipc.ts`, handle it here, expose it in `../preload/index.ts`.

**Tests:** none here. The logic lives in `core/` and is tested there; the UI is tested end to end through CDP ([docs/threads.md](../../docs/threads.md) → Developing).
