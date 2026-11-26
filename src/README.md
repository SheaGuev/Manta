# src

Manta's source, split by Electron process. Each folder has its own README listing every file.

| Entry | What it is |
|---|---|
| `core/` | All logic that touches disk, git, CRDTs and agents. Plain Node, no Electron, tested directly. |
| `main/` | Electron main process: window, file watchers, IPC handlers that call into `core/`. |
| `preload/` | Bridges IPC into `window.manta` for the renderer. |
| `renderer/` | React UI. No Node access. |
| `shared/` | Types and IPC channel names both sides agree on. |

## Who may import what

```
renderer ── window.manta ──▶ preload ── IPC ──▶ main ──▶ core
   │                                                       │
   └──────────────▶ shared/ipc.ts ◀────────────────────────┘

renderer ──▶ core/threads/threads.ts   the one exception: reads thread anchors from its own Yjs replica
```

- `shared/` imports nothing.
- `renderer/` never imports `core/` except `core/threads/threads.ts`, which must stay free of Node imports.
- `core/` never imports Electron, so it runs under vitest as plain Node.

## Tests

Tests live in a `__tests__/` folder next to the code they cover. `__tests__/` here holds repo-wide checks: `directoryReadmes.test.ts` fails when a folder's README table doesn't list exactly the folder's files and subfolders.
