# core/lsp

Language servers for the code editor: one process per root and server, speaking JSON-RPC over stdio, with the renderer's LSP client (`renderer/src/lib/lsp/`) on the other end of IPC. `main/` composes these; nothing else in core uses them.

| Entry | What it does |
|---|---|
| `languageServerHost.ts` | `LanguageServerHost`: starts a server on first use for a root and language (the same window shares it across languages, a reloaded window gets a fresh one), passes messages both ways, answers the server requests the client refuses (configuration, capability registration, progress; diagnostic refreshes go on as notifications), forwards file events to servers that watch files, keeps info logs in main, stops idle servers (no open file for 10 minutes), reports crashes with the end of stderr and stops restarting one that crashes 3 times in 3 minutes. `closeRoot`, `shutdown` (`shutdown` and `exit`, then kill). |
| `serverCatalog.ts` | Which servers Manta knows and how to start them. `typescriptServer`: TypeScript 7's own server (`tsc --lsp --stdio`), the project's copy when it has TypeScript 7 or later, Manta's otherwise. `nativeTypescriptBinary`. |
| `framing.ts` | `MessageReader` splits stdout into messages by `Content-Length`; `frame` adds the header (a byte count). |

**Imports:** `../../shared/` only; no Electron, so it runs under vitest.

**Tests:** `__tests__/framing.test.ts`; `__tests__/languageServerHost.test.ts` drives `scripts/fake-language-server.mjs` (requests the host answers, watched files, crashes, idle stop, owners, closing roots) and the real TypeScript 7 server (definition across files, hover, a type error).
