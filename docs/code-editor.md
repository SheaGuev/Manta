# The code editor

How the worktree code editor works, for anyone changing it. Built for roadmap item P10 ([roadmap.md](roadmap.md)). The plan, decisions and results live outside the repo.

It stays CodeMirror over the same Yjs replica as docs (`components/Editor.tsx`), so threads, diffs and outside edits keep working. Four layers sit on top.

## 1. Editing basics

| What | Where |
|---|---|
| Find and replace (Cmd+F, Cmd+Opt+F), Cmd+D, Cmd+Shift+L; docs get these too | `lib/editorBasics.ts` (`findInFile`) |
| Folding, matching and auto-closing brackets, indent on input, Ctrl+G go to line | `lib/editorBasics.ts` (`codeEditing`) |
| Opt-click adds a cursor, Opt+Shift+drag a column; Cmd-click is kept for go to definition | `lib/editorBasics.ts` |
| Word completion until a language server is ready | `lib/editorBasics.ts` (`wordCompletion`) |
| Cmd+P quick open: fuzzy match on the path (`chpan` → `ChangesPanel.tsx`), several words (`auth panel`), `name:42`, matching recent files first | `components/QuickOpen.tsx`, `lib/search.ts` (`fuzzyMatch`, `rankFiles`, `withRecentFirst`) |
| Cmd+Shift+F from anywhere: the panel's search, filled with the editor's one-line selection | `App.tsx` (capture-phase shortcut), `RightPanel.tsx` (`SearchRequest`) |

## 2. Language servers

```
renderer                                   main                                 server process
Editor ─ codeIntelligence (lsp-client) ─IPC─▶ LanguageServerHost (core/lsp) ─stdio─▶ tsc --lsp --stdio
       └ LintServer (ESLint, Biome, Ruff) ─IPC─▶  one process per root + server  ─stdio─▶ vscode-eslint-language-server …
```

- **One process per root and server**, started on the first file that needs it. The same window shares it across languages (`.ts` and `.tsx`). A reloaded window (a new preload `LOAD_ID`) gets a fresh one, since a server takes one `initialize`.
- **TypeScript is built in:** TypeScript 7's own server, native code (`tsc --lsp --stdio`). It uses the project's copy when that is TypeScript 7 or later, and Manta's otherwise (`typescript` is a runtime dependency). A project on TypeScript 6 uses Manta's.
- **Primary and lint servers:** each file has at most one *primary* server, driven by `@codemirror/lsp-client` (hover, completion, signature help, definitions). *Lint* servers run beside it through `lib/lsp/lintClient.ts`, because lsp-client drives only one server per editor. Each server's diagnostics are kept apart (`lib/lsp/diagnosticSources.ts`), so one server's report never erases another's.
- **What main does besides passing messages** (`languageServerHost.ts`):
  - **Answers server requests the client would refuse:** `workspace/configuration` from the recipe's settings, capability registration, progress, `workspace/workspaceFolders`, and requests specific to one server (ESLint's `eslint/confirmESLintExecution`, JSON's `vscode/content` schema fetches).
  - **Adds what lsp-client's `initialize` lacks:** a workspace folder, and the `workspace.configuration` capability. It then pushes `workspace/didChangeConfiguration`, which YAML's and JSON's servers wait for.
  - **Watches files for the server:** sends Manta's own file watcher events to servers that register for watched files, so TypeScript 7 doesn't start watchers of its own (some cover `/private/**`).
  - **Filters logs:** drops info-level `window/logMessage`.
  - **Opens one at a time per root and server,** so two editors opening at once don't start two processes.
  - **Manages lifecycle:**
    - stops a server 10 minutes after its last file closes;
    - reports crashes with the end of stderr;
    - stops restarting a server after 3 crashes in 3 minutes;
    - stops a root's servers when it is removed.
- **Errors are pulled:** TypeScript 7 reports errors only when asked (`textDocument/diagnostic`), which lsp-client doesn't do. `lib/lsp/pullDiagnostics.ts` asks after a file opens, when typing pauses, when another file changes, and on `workspace/diagnostic/refresh`.
- **Replaced from lsp-client:**
  - **Rename (F2):** `lib/lsp/rename.ts`. lsp-client's rename skips files without a tab; Manta edits those through their Yjs docs in main and saves them at once, so the server reads the new text.
  - **References (Shift+F12):** `lib/lsp/references.ts`. lsp-client's panel throws for files without a tab.
- **Cmd+Shift+O** lists the file's symbols (`textDocument/documentSymbol`, `lib/lsp/symbols.ts`, `components/SymbolPicker.tsx`). **Cmd+.** lists the primary server's quick fixes and refactors for the cursor's line, with the line's errors as context, so TypeScript can offer to add a missing import (`lib/lsp/codeActions.ts`, `components/QuickFixPicker.tsx`). Edits from rename and quick fixes go through `lib/lsp/applyEdit.ts`.
- **Jumps to other files:** `lib/lsp/navigation.ts`. A target inside the root opens its own tab. Anything else (`node_modules` ignored by git, TypeScript's `lib.*.d.ts`) opens in a read-only tab (`EditorMode` `readonly`), which main serves through `readOnlyFile` (inside the root or the bundled TypeScript only).
- **Status bar:** each server for the context, with its state and a Restart button after a crash (`StatusBar.tsx`, `useLanguageServers`).
- **Debugging:** `MANTA_LSP_TRACE=1` logs each message's direction, method and first 400 characters to main's stdout.

## 3. Format on save

Cmd+S in a code file means "format, then save now". Manta saves as you type anyway.

1. **The renderer calls `formatFile`.** Main waits for the editor updates already sent (`editorUpdates`), so the last keystroke is included.
2. **Main finds the project's own formatter** (`core/format/formatters.ts`, `resolveFormatter`):
   - **Prettier** when a Prettier config is found from the file's folder up to the root;
   - else **Biome** with a `biome.json`;
   - else **Ruff** for Python with a Ruff config.
   - Tools come from the root, the repo's main checkout (a fresh worktree has no `node_modules`), the PATH, or the Ruff plugin.
3. **It runs the formatter on stdin** with a 5 s timeout. `Workspace.applyFormatted` applies the output as minimal Yjs edits (`computeTextEdits`), so cursors, undo and thread anchors survive, then writes the file. If the text changed while the formatter ran, nothing is applied.
4. **Without a project formatter,** the language server formats (`lib/lsp/formatting.ts`). A formatter error shows its first line in the status bar, and the file is still saved. Docs only save.

## 4. Plugins and themes

The Plugins tab (from the **+** menu, `components/PluginsView.tsx`) installs language servers, linters and formatters from **Mason's registry**, and **VS Code colour themes** from Open VSX. Plugins are declarative: nothing they ship runs inside Manta, and their servers are separate processes.

- **Install:** `core/plugins/installer.ts`, by the package's source:
  - npm, with `--ignore-scripts`;
  - PyPI, into a virtualenv, with `uv` when present;
  - GitHub release assets and other downloads, unpacked with tar, unzip or gunzip;
  - cargo and go, when their toolchains are on the PATH.
  - Installs land in `<userData>/plugins/tools/<package>`, in place, because virtualenvs can't be moved. A failed install puts the previous one back.
  - An archive with an entry outside its folder (`../`), or a package name that is a path, isn't installed.
- **Launch:** `core/plugins/recipes.ts`. Mason knows how to install, not how to run, so Manta has a recipe per core server. A recipe gives the command, languages, primary or lint, the project config a linter needs (ESLint, Biome, GraphQL start only with one at the root), and the settings. Swift uses Xcode's `xcrun sourcekit-lsp` and installs nothing. Biome prefers the project's own binary.
- **Core set:** Pyright (or basedpyright), Ruff, ESLint, Biome, YAML (SchemaStore, CloudFormation tags), JSON (SchemaStore), GraphQL, Terraform, Swift, Kotlin (beta), Protobuf (buf), Bash.
- **Custom servers:** a package without a recipe can run once given its command and language ids.
- **State:** `<userData>/plugins/plugins.json` (`core/plugins/pluginManager.ts`), holding installed tools, switched-off servers, custom servers and the theme. Mason's registry is cached for a day and used offline; the SchemaStore catalog is cached for a week.
- **Grammars:** GraphQL (`cm6-graphql`) and HCL/Terraform (`codemirror-lang-hcl`) are bundled, since `@codemirror/language-data` lacks them (`Editor.tsx`, `EXTRA_LANGUAGES`).
- **Themes:** `core/plugins/themes.ts` downloads the `.vsix` and converts its theme JSON (JSONC, following `include`). Workbench colours become the code editor's surface, and TextMate token scopes become token kinds, all as `--code-*` CSS variables. `lib/codeHighlight.ts` reads those, with Manta's palette as the fallback. Only `--code-*` variables are accepted (`parseEditorTheme`), so a theme can't restyle the app; docs and the app chrome keep Manta's colours.

## Developing

- **Unit tests:**
  - `core/lsp/__tests__/` drives `scripts/fake-language-server.mjs` and the real TypeScript 7 server.
  - `core/plugins/__tests__/` covers the real Mason entries in `fixtures/` and installs from a local HTTP server.
  - `MANTA_NETWORK_TESTS=1` adds real npm, PyPI and Open VSX installs.
  - `core/format/__tests__/` uses real Prettier and Biome when `MANTA_FORMATTER_PROJECT` names a project that has them installed.
- **UI e2e** (the dev-scripts folder, see [threads.md](threads.md) → Developing; `run-ui.sh <script>`):
  - `editor-e2e.mjs` covers layer 1;
  - `lsp-e2e.mjs` covers layer 2, on a TypeScript fixture, including killing the server;
  - `format-e2e.mjs` covers layer 3, with Prettier and Biome copied from a real project;
  - `plugins-e2e.mjs` covers layer 4, with real installs, a real `serverless.yml` and GraphQL schema, and an Open VSX theme. It needs the network, and takes about 5 minutes.
- Run e2e scripts one at a time: each runner stops whatever holds port 9339.

## Known limits

- **Undo:** Cmd+Z doesn't undo a format. The formatter's edits come from main, and the Yjs undo manager tracks only the editor's own edits.
- **Lint servers** add diagnostics only: Cmd+. offers the primary server's quick fixes, not ESLint's or Ruff's. Quick fixes that only run a server command are left out, since Manta doesn't take `workspace/applyEdit`.
- **Linter and GraphQL configs** are looked for at the context root only, not in subfolders of a monorepo.
- **No checksums:** Mason's registry has none for downloads. They come over HTTPS from GitHub or the vendor (HashiCorp, JetBrains).
- **Swift** works best with a built Xcode project or a `buildServer.json` (`xcode-build-server`); without one, only the file itself and the standard library resolve.
