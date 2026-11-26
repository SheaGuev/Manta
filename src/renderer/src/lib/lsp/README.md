# renderer/src/lib/lsp

The renderer half of language servers: an LSP client per root and server (`@codemirror/lsp-client`), talking over IPC to the processes main runs (`core/lsp/`).

| Entry | What it does |
|---|---|
| `clients.ts` | `clientsFor`: the connected clients for a file's language, the primary server's `LSPClient` and a `LintServer` per lint server, opened through `lspOpen`; reconnects after a crash, `restartServer` for the status bar, `forgetOpenedServers` and `onServersChanged` when plugins change. Advertises Manta's file watching and pulled diagnostics. |
| `codeIntelligence.ts` | The code editor extension: hover, server completion, signature help, diagnostics, F12 and Cmd-click to the definition (Cmd held underlines the symbol), Shift+F12 references, F2 rename. |
| `mantaWorkspace.ts` | `MantaWorkspace`: the files a client has open, several views per file, URIs matched by path, jumps to other files through `showFile`. |
| `references.ts` | Shift+F12: every reference in a panel grouped by file, including files without a tab (lsp-client's panel can only list open files); Enter or a click opens it. |
| `formatting.ts` | `formatWithServer`: the language server's `textDocument/formatting`, for Cmd+S in projects without a formatter of their own. |
| `codeActions.ts` | `quickFixes` (`textDocument/codeAction` with the line's errors as context) and `applyQuickFix` (resolving the edit when needed), for Cmd+. |
| `applyEdit.ts` | `applyWorkspaceEdit`: a server's edit applied to files with a tab through their editor, and to files without one through their Yjs doc in main, saved at once. |
| `symbols.ts` | `fileSymbols`: the file's symbols from `textDocument/documentSymbol`, flattened in document order, for Cmd+Shift+O. |
| `rename.ts` | F2: rename everywhere the server says, applying edits to files without an open tab through their Yjs docs in main (lsp-client's rename skips those). |
| `workspaceEdits.ts` | `editsByUri` (a `WorkspaceEdit`'s text edits, from `changes` or `documentChanges`) and `editOffsets` (LSP positions as offsets, last first). |
| `diagnosticSources.ts` | Each server's diagnostics kept apart in the editor and shown together (`showDiagnostics`), and LSP diagnostics as editor ones (`toDiagnostics`). |
| `lintClient.ts` | `LintServer`: a lint server (ESLint, Biome, Ruff) beside the primary one, which lsp-client can't drive in the same editor: opens files, sends them in full after typing pauses, shows its pushed or pulled diagnostics. |
| `pullDiagnostics.ts` | Errors from servers that report them when asked (`textDocument/diagnostic`), after a file opens, when typing pauses and when another file or the server says they're stale. |
| `navigation.ts` | Where a jump to another file lands: `App` opens the tab (`setFileOpener`), editors register while mounted (`noteEditor`), `showFile` waits for the target's editor. |
| `ipcTransport.ts` | The lsp-client `Transport` for one session, over one shared IPC listener. |
| `fileUris.ts` | `fileUri`, `uriPath`, `relativeTo`: file URIs from root-relative paths and back, compared by decoded path. |

**Tests:** `__tests__/`, for the pure parts (`fileUris`, `workspaceEdits`). The rest runs in UI e2e (`lsp-e2e.mjs`) against TypeScript 7's server.
