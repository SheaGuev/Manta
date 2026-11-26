# shared

The contract between main and renderer. Imports nothing outside this folder, so both sides (and `core/`) can depend on it.

| Entry | What it does |
|---|---|
| `languages.ts` | `languageIdFor`: a file's LSP language id from its extension, for main's language servers and the renderer's clients. |
| `mapBoard.ts` | A context map's board, pure: `boardRows` (a row per live launch session with what it needs from the user, ranked), `sortBoard`, `boardText` (the compact text a coordinator reads) and `signalOf` (what wakes one). Shared by core's coordinator and the renderer's Board. |
| `ipc.ts` | Every type that crosses IPC (`Project`, `FileChange`, `ThreadInfo`, `ThreadEvent`, `OpResult`, ...), the `MantaApi` interface `window.manta` implements, and the `Channel` names. |

**Rule:** a type the renderer needs is defined here; `core/` imports it and may re-export it (`repo/git.ts`, `threads/threads.ts`, `threads/threadForks.ts` do). Never the reverse.

**Tests:** `__tests__/mapBoard.test.ts`.
