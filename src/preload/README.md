# preload

Runs in the renderer's context with IPC access and exposes `window.manta`, the only way the renderer reaches the main process.

| Entry | What it does |
|---|---|
| `index.ts` | Implements `MantaApi` (`../shared/ipc.ts`): one `ipcRenderer.invoke` per call, and `onThreadEvent` / `onRemoteUpdate` / `onFilesChanged` subscriptions that return an unsubscribe function. |

**Imports:** `../shared/ipc.ts` only. No logic belongs here: if a call needs checking or shaping, do it in `../main/`.
