# Quality bar: performance, state and polish

Manta should feel at least as fast and polished as Orca, the agentic dev environment it borrows its workspace ideas from: worktrees, terminals, agent sessions. Orca is open source (https://github.com/stablyai/orca), so this file compares the two codebases. It lists where Manta is behind, how to fix each gap, and roughly how long each fix takes. Roadmap item P11 ([roadmap.md](roadmap.md)) tracks it.

**Snapshot of 2026-10-23:**
- Manta at `301542c`; Orca at `89b3d382`, its `package.json` version 1.4.214 (the installed app was 1.4.237).
- Manta's numbers come from tracing its code, plus read-only git timings on a large app repo: `git status` about 0.12 s, `git ls-files` about 0.10 s.
- Neither app was profiled while running.
- Orca paths are relative to its repo. Line numbers drift; when one no longer matches, search for the quoted name.

Codes: G for gaps, A for quick wins. They stay fixed so they can be referenced from plans and commits. When an item is fixed, mark it done here rather than deleting it.

## Order

1. **G2 and the quick wins (A1 to A10):** about a day, and the biggest felt difference.
2. **G1, then G4:** most of the remaining slowness.
3. **G5, before split panes:** splits multiply its cost.
4. **G3, G6, G7, G8, G9** as they fit around feature work.

## Gaps

| Code | Gap | Effort | Status |
|---|---|---|---|
| G1 | Every file change refetches every panel | 2–3 days | Done: events say what changed; one shared status run per root, every 3 s at most. A typing pause 9 → 4 git commands, a session saving 10 files 90 → 12, the Branch tab open 18 → 8 ([living-docs.md](living-docs.md), Telling the panels) |
| G2 | The daily-driver Manta is the dev server | ~1 hour | Done: `npm run app`, dev on `manta-dev`, minified renderer (3.06 → 1.50 MB) |
| G3 | Terminals run in main, with no flow control | 4–6 days | Open |
| G4 | Switching context throws away terminals and editors | ~1 day | Done: the 4 most recent contexts keep their tab pages mounted and hidden, and at most 6 hidden terminals keep a WebGL context. 10 docs ↔ worktree round trips 766 → 299 ms of renderer time, the frame after a switch 30 → 7 ms ([terminals.md](terminals.md), Renderer) |
| G5 | One big component for app state, no memoisation | 2–3 days | Open |
| G6 | Startup blocks first paint and slows down as docs pile up | 1–2 days | Open |
| G7 | No list virtualisation | ~1 day | Open |
| G8 | Session state lives in the renderer; doc saves write more than they need to | ~1 day | Open |
| G9 | No lint, CI, error boundaries or packaging | 2–3 days | Open |

### G1. Every file change refetches every panel

**Manta:**
- **The watcher:** one recursive `fs.watch` per workspace (`src/main/index.ts`, `watchWorkspace`). It skips only `.git`: `node_modules`, `dist` and the like still reach main's callback, and so do Manta's own doc writes.
- **The event:** it sends a bare "this root changed" (`filesChanged`), debounced 250 ms, with no paths.
- **The refetch:** every hook built on `useRootData` (`src/renderer/src/lib/hooks.ts`) reloads its whole dataset on that event:
  - `useFiles('all')` runs even when the Files tab isn't showing (`RightPanel.tsx`): one `git ls-files`.
  - `useChanges`: 4 git spawns, plus reading every untracked file.
  - The status bar's `useRepoStatus`: 4 more spawns, reading untracked files one after another (`git.ts`).
  - The Branch tab, when open: about 10 more (`workspace.ts` `branch()`, `git.ts`).
  - Each open thread tab: 4 to 7 IPC calls (`ThreadView.tsx` `load`).
- **Typing triggers it:** the 300 ms debounced doc write (`WRITE_DEBOUNCE_MS`, `workspace.ts`) trips the watcher. Every pause in typing costs about 9 git spawns, or about 19 with the Branch tab open. Claude sessions editing a worktree trigger it continuously.
- **Payload:** on a large app repo, `listFiles` returns 8,429 paths (about 500 KB) per refresh. `FileTree` rebuilds the tree and every row re-renders.

**Orca:**
- **Watcher:** `@parcel/watcher` in a crash-isolated child process, with an ignore list (`src/main/ipc/filesystem-watcher-ignore.ts`). A comment there measures about 29× client CPU without the `node_modules` exclusions.
- **Events:** batched at 75 to 100 ms, and they carry the changed paths. The file explorer reconciles only the affected directories (`file-explorer-watch-reconcile.ts`).
- **Git status:**
  - debounced 125 ms, with a 3 s minimum gap and a 60 s safety poll (`useGitStatusPolling.ts`)
  - concurrent identical reads share one run (`status-read.ts`)
  - caches are cleared on every git mutation (`git-read-cache-invalidation.ts`)
  - every git spawn goes through a global admission cap (`git-admission-state.ts`)

**Fix:**
1. **Watcher:** in `watchWorkspace`, drop ignored directories, drop events for a doc whose disk text is what Manta just wrote, and send `{ root, paths }`.
2. **Shared repo status:** a new `src/core/repo/repoStatus.ts` runs one `git status --porcelain=v2 --branch -z` and one `--numstat`, shared by Changes and the status bar. It runs once at a time per root, waits at least 1–3 s between runs, and is invalidated after Manta's own git operations.
3. **File list:** re-list only when files are added or removed.
4. **Hooks:** `useRootData` keeps the previous array when the result is unchanged, so nothing re-renders.

**Effort:** 2–3 days. Moving to `@parcel/watcher` later adds about half a day.

### G2. The daily-driver Manta is the dev server

**Manta:**
- **Dev build:** everyday use runs `electron-vite dev --watch`. That means React's development build, double-run effects from `<StrictMode>` (`src/renderer/src/main.tsx`), and unbundled modules.
- **Restarts kill sessions:** a change to main or preload restarts the app ([threads.md](threads.md), Developing), and PTYs live in main ([terminals.md](terminals.md)), so every restart ends the live Claude sessions.
- **Shared profile:** dev uses the real profile (`~/Library/Application Support/manta`).
- **Unminified build:** the built renderer bundle is 3 MB (about 90k lines), and Streamdown's markdown stack and parse5 load eagerly. There are no `lazy()` imports.

**Orca:** dev runs under its own profile (`src/main/startup/configure-process.ts`), with a renamed app bundle per branch (`config/scripts/run-electron-vite-dev.mjs`). PTYs live in a daemon that outlives the app (`daemon-provider-state.ts`).

**Fix:**
1. Use a built copy every day: `npm run build && npm start`, or a packaged app (G9).
2. Point `npm run dev` at its own profile with `MANTA_USER_DATA`.
3. Turn on minification in `electron.vite.config.mts`.

**Effort:** about 1 hour.

### G3. Terminals run in main, with no flow control

**Manta:**
- **Main process:** node-pty and the `@xterm/headless` parser run there (`src/core/terminal/terminalHost.ts`), on the same event loop as git, IPC, Yjs merges and the watcher.
- **No throttle:** output is batched every 16 ms with no backpressure (a known limit in [terminals.md](terminals.md)).
- **DOM renderer:** the renderer draws xterm with the DOM renderer; there's no WebGL addon (`TerminalView.tsx`).

**Orca:**
- **Daemon:** PTYs live in a detached daemon (`src/main/daemon/daemon-launched-child-spawn.ts`).
- **Batching:** 2 ms (`src/main/ipc/pty/delivery/constants.ts`).
- **Backpressure, three layers:**
  - the renderer acks the characters it has processed, with 512 KB in flight per PTY and 8 MB in total (`constants.ts`)
  - producer watermarks of 256 KB high and 32 KB low (`pty-producer-flow-control.ts`)
  - real `pause()` and `resume()` on the PTY (`subprocess-handle.ts`)
- **WebGL:** the renderer uses WebGL, falling back to DOM on context loss (`pane-webgl-renderer.ts`).

**Why it matters:** one terminal flooding output (a test run, `cat` of a big log) stalls typing in every other terminal and delays doc saves. Running in main is also why a restart kills every terminal.

**Fix:**
1. **Own process (1–2 days):** move `TerminalHost` into a child process (`utilityProcess`, or a fork with `ELECTRON_RUN_AS_NODE`). Main relays to the renderer over a `MessagePort`.
2. **Flow control (half a day):** the renderer acks bytes in `term.write`'s callback, and the host pauses the PTY above about 512 KB in flight.
3. **Survive restarts (2–3 days):** make the host a detached daemon with a socket, and reattach on launch from `terminals.json` (`terminalRecords.ts`).

**Effort:** 4–6 days in total.

### G4. Switching context throws away terminals and editors

**Manta:**
- **What's rendered:** only the current context's tabs (`App.tsx`), and `RightPanel` is keyed by root.
- **What a switch costs:** every switch disposes each xterm (`TerminalView.tsx`) and CodeMirror view (`Editor.tsx`).
- **What switching back costs:** a serialise of up to 5,000 rows per terminal in main (`terminalHost.ts`), a full Yjs state per doc (`workspace.ts`), language loading, and a cold reload of the right panel.

**Orca:**
- **Parking:** hidden panes stay mounted for 30 s. The 4 most recent worktrees and 6 tabs stay warm for 5 minutes, with rendering suspended while hidden (`terminal-hidden-view-parking.ts`, `pane-rendering-control.ts`).
- **Their reasoning,** in their own comment: "Reveal cost is a flat ~170ms remount… cutting remount *frequency* beats shaving replay."

**Fix:** keep the tab pages of the last ~4 contexts mounted and `hidden` (`App.tsx`). While hidden, `TerminalView` stops the cursor blink and skips `fit`.

**Effort:** about 1 day.

### G5. One big component for app state, no memoisation

**Manta:**
- **One component:** all shell state is `useState` in `App.tsx`, about 800 lines.
- **No memoisation:** there are no `memo(` calls in `src/renderer`, and every tab gets fresh inline closures.
- **Re-renders:** each terminal change builds a new Map (`hooks.ts`, `useTerminals`). That re-renders `App` and every Editor, ThreadView, TerminalView, Sidebar and RightPanel in the context.

**Orca:**
- **Store:** zustand with about 49 slices (`src/renderer/src/store/index.ts`), read through per-field selectors.
- **Lint:** rules flag missing or freshly created selectors (`.oxlintrc.json`, `config/oxlint-plugins/app-store-performance.mjs`).
- **CI benchmark:** a selector fan-out benchmark (`config/scripts/zustand-selector-fanout-benchmark.mjs`).

**Why it matters:** the cost grows with every tab and feature. Split panes would multiply it.

**Fix:**
1. **Store:** add `src/renderer/src/store/` (zustand, or `useSyncExternalStore`) for projects, tab sets, terminals and per-root repo data.
2. **Split `App.tsx`:** into Shell, TabStrip and TabPages.
3. **`memo`:** wrap TerminalView, Editor and ThreadView, and give them stable props.

**Effort:** 2–3 days.

### G6. Startup blocks first paint and slows down as docs pile up

**Manta:**
- **Window waits:** the window is created only after `ProjectRegistry.load` and `TerminalManager.open` finish (`src/main/index.ts`).
- **Blank first paint:** the renderer shows an empty app until `listProjects` returns (`App.tsx`).
- **Doc loading:** the first touch of a workspace loads every doc that has stored CRDT state, one after another (`Workspace.open`). Each load merges and rewrites its `log.bin` (`docStore.ts`), so startup grows with every doc ever opened.

**Orca:**
- **Window:** hidden until `ready-to-show` (`main-window-state-lifecycle.ts`), with non-critical work deferred until after the first window (`first-window-deferral.ts`).
- **Lazy loading:** 64 `lazy()` imports.
- **Checks:** a boot-graph check fails the build if heavy code enters the entry bundle (`config/scripts/renderer-boot-graph.mjs`), and per-step startup timings are recorded (`startup-diagnostics.ts`).

**Fix:**
1. **Window first:** create the window before the slow loads.
2. **Background doc loading:** load stored docs after first paint, and make commit and pull wait for that load, so outside edits are still absorbed first ([living-docs.md](living-docs.md)).
3. **Lazy imports:** ThreadView with Streamdown, and CompareView with `@codemirror/merge`.

**Effort:** 1–2 days.

### G7. No list virtualisation

**Manta:** `FileTree` renders every expanded row recursively. Search results go up to 500 (`workspace.ts`), and thread transcripts render in full.

**Orca:** `@tanstack/react-virtual` for the file tree (`use-file-explorer-row-scrolling.ts`), search (`SearchResultsPane.tsx`), the sidebar, diffs and the chat transcript.

**Fix:** flatten the tree to its visible rows (`lib/tree.ts`), then virtualise `FileTree` and `SearchResults`.

**Effort:** about 1 day.

### G8. Session state lives in the renderer; doc saves write more than they need to

**Manta:**
- **Session:** written to `localStorage` on every tab change (`App.tsx`), and pane widths on every pointer move (`hooks.ts`, the resize hook).
- **Unverified:** dev (`http://localhost`) and the built app (`file://`) are different origins, so they probably keep separate sessions.
- **Doc saves:**
  - each Yjs update is its own `appendFile` (`livingDoc.ts`)
  - each typing pause runs a full `encodeStateAsUpdate`, plus up to 4 atomic writes even when the sync-point and staged snapshots haven't changed (`docStore.ts`, `saveMeta`)
  - nothing calls fsync

**Orca:**
- **Database:** SQLite owned by main, in WAL mode with `synchronous=FULL` and a schema version (`profile-state-database.ts`).
- **Writes:** debounced at 1 s with a 5 s maximum wait, on a worker thread (`write-scheduling.ts`). Renderer patches are debounced at 150 ms (`session-write-subscriber.ts`).
- **Durability:** `durable-file-write.ts` fsyncs.

**Fix:**
1. **Session in main:** move it to `<userData>/session.json`, debounced and versioned, and read before first paint.
2. **Pane widths:** write them on pointer-up only.
3. **`saveMeta`:** write only the snapshots that changed.

**Effort:** about 1 day.

### G9. No lint, CI, error boundaries or packaging

**Manta:**
- **No lint or CI:** no linter or formatter, and no `.github/` workflows. The "no `as` casts" rule is enforced only in review ([patterns.md](patterns.md)).
- **e2e outside the repo:** the UI e2e scripts live outside the repo ([threads.md](threads.md), Developing).
- **No crash handling:** no error boundary, `render-process-gone` or `uncaughtException` handler. One render error blanks the whole app.
- **No packaging:** no electron-builder config, no auto-update.

**Orca:**
- **Lint and format:** oxlint, with casts banned (`config/oxlint-code-quality-casting.json`), and oxfmt; both run through husky and lint-staged.
- **e2e:** about 585 Playwright Electron specs (`tests/playwright.config.ts`).
- **Crash handling:** `crashReporter` (`crashpad-capture.ts`) and `RecoverableRenderErrorBoundary`.
- **Logs:** rotated NDJSON (`local-file-sink.ts`).
- **Updates and packaging:** electron-updater (`updater-setup.ts`) and an electron-builder config (`config/electron-builder.config.cjs`).

**Fix:**
1. **Lint:** oxlint with `consistent-type-assertions: never`, plus oxfmt.
2. **e2e in the repo:** move the scripts into `e2e/` on Playwright's `_electron`.
3. **CI:** a GitHub Actions workflow running typecheck and tests.
4. **Crash handling:** an error boundary around each tab page, and a reload on `render-process-gone`.
5. **Packaging:** an electron-builder config.

**Effort:** 2–3 days.

## Quick wins

Each is under about 2 hours.

| Code | What | Where | Status |
|---|---|---|---|
| A1 | Stop the synchronous shell lookup in main. It blocks main for 0.4–0.8 s (measured), and its cache is cleared on every Claude status check, which runs on mount (twice under StrictMode) and on each popover open. Resolve `claude` and `gh` asynchronously from the PATH `terminalBaseEnv()` already reads. Orca bans synchronous spawns in main with a ratchet (`check-main-sync-spawn-ratchet.mjs`) | `src/main/index.ts` (`findInLoginShell`), `ClaudeStatus.tsx` | Done: a PATH scan (`findOnPath`) of the env terminals already load; launches wait for it |
| A2 | Filter `node_modules`, `dist`, `build`, `.next`, `.cache` and `out` out of the watcher | `src/main/index.ts` (`watchWorkspace`) | Done: `core/repo/watchIgnore.ts`, the VS Code and Orca list (`out` isn't in it) |
| A3 | Load the file list only while Files or search is showing, and keep the previous array when it hasn't changed | `RightPanel.tsx`, `hooks.ts` | Done |
| A4 | Derive the status bar's +/− counts from Changes, saving 4 spawns and the one-by-one reads of untracked files | `StatusBar.tsx`, `git.ts` | Done differently: untracked files are read 16 at a time in parallel. Deriving the counts from Changes needs shared renderer state, so it waits for G5 |
| A5 | Load `@xterm/addon-webgl`, falling back to DOM on `onContextLoss` | `TerminalView.tsx` | Done: 0.19.0, released with xterm 6.0.0. Terminal text is no longer in the DOM; e2e scripts read `terminalSnapshot` |
| A6 | One terminal-data dispatcher keyed by terminal id, instead of one listener per TerminalView filtering every message | `TerminalView.tsx`, `hooks.ts` | Done: `lib/terminalData.ts` |
| A7 | An app menu, so ⌘W closes a tab. There's no `Menu` today, so Electron's default applies and ⌘W closes the window | `src/main/index.ts` | Done: File → Close Tab (⌘W), Close Window (⌘⇧W) |
| A8 | Write pane widths on pointer-up only | `hooks.ts` | Done: saved 300 ms after the last change |
| A9 | `saveMeta`: skip `sync-point.bin` and `staged.bin` when they haven't changed | `docStore.ts` | Done: compared by state reference, loaded states count as written |
| A10 | Daily-drive a built app; dev gets its own profile (G2) | `package.json`, `electron.vite.config.mts` | Done (G2) |

## Quality-of-life features Orca has

| Feature | Orca | Effort for Manta |
|---|---|---|
| Drag to reorder tabs | dnd-kit, `SortableTab.tsx` | 0.5 day |
| Tab menu: pin, close others, close to the right, rename, colour, copy path | `SortableTabContextMenu.tsx` | 0.5 day |
| Reopen a closed tab (⌘⇧T) | `recently-closed-tabs.ts` | 2–3 h; Back history already exists in `App.tsx` |
| ⌘W, ⌘1…9, Ctrl-Tab most-recent switcher | keybindings | 0.5 day |
| Split terminal panes, ⌘D / ⌘⇧D, as a binary tree | `terminal-tab-types.ts` | 2–3 days, after G5 |
| Editor groups: any tab in any split, drag to split | `tab-types.ts` | 2–3 days more |
| Command palette (⌘J) and quick open (⌘P), with cmdk | — | 1–1.5 days |
| Rebindable keybindings | `src/shared/keybindings/` | 1–2 days |
| OS notifications, dock badge, unread markers per tab and worktree | `native-notification-delivery.ts`, `unread-badge.ts` | 0.5–1 day; the session states already exist |
| PR status on worktree rows, a Checks panel, review comments | `WorktreeCardStatusSlot.tsx`, `ChecksPanel.tsx`, `pr-refresh-coordinator.ts` | 2–3 days. Manta shows a PR only on implementation chips |
| Ahead/behind counts and push | — | 0.5 day |
| Terminal search and unicode11 addons | — | 2–3 h |
| Clickable terminal links that open in the app. ⌘-click a URL to open it in Orca's browser (Shift for the other destination), with URLs wrapped across rows kept whole. ⌘-click a file path such as `src/foo.ts:42` to open it in the editor at that line, after checking the file exists. Manta underlines URLs only, and a click sends them to the system browser (`TerminalView.tsx`, `WebLinksAddon` → `window.open` → `shell.openExternal` in `src/main/index.ts`) | `terminal-web-link-click.ts`, `terminal-url-link-hit-testing.ts`, `terminal-link-handlers.ts`, `terminal-file-link-target.ts` | File paths: about 1 day (an xterm link provider resolving paths against the terminal's folder, opening code files in the editor and docs as docs). URLs in the app: needs the embedded browser below |
| Embedded browser per worktree (`<webview>`) | `createMainWindow.ts` | 3–5 days |
| Popout windows, floating terminal | — | Later |

## Where Manta is already as good or better

- **Claude session state from hooks:** a documented state table, and changes are sent only when the state actually changes (`terminalHost.ts`). Same approach as Orca's, and much simpler.
- **Exact terminal remount:** snapshot plus sequence numbers (`terminalHost.ts`, `TerminalView.tsx`). The same design as Orca's headless emulator.
- **Doc keystrokes are deltas:** one Yjs update per edit, one IPC send, and no echo back (`Editor.tsx`, `workspace.ts`).
- **Writes:** a serial queue, atomic writes and completeness markers ([patterns.md](patterns.md)). Only fsync is missing (G8).
- **Security:** `sandbox: true` with context isolation, and every IPC argument validated (`src/main/index.ts`).
- **Type strictness:** `strict` plus `noUncheckedIndexedAccess`. Orca bans casts only on changed lines.
- **Tests:** real git repos instead of mocks, and a test that keeps every folder's README table accurate (`src/__tests__/directoryReadmes.test.ts`).
- **PR lookups:** cached for a minute, with a 10 s timeout (`github.ts`).
- **Dependencies:** a small set.

## Not verified

- Orca's effective TypeScript strict flags (its base config package wasn't installed in the clone).
- When Orca falls back to PTYs in main.
- Whether Orca's dev mode restarts main.
- Runtime numbers for either app. Profiling both under the same load (a large repo, a noisy terminal, a typing burst) would confirm the ranking.
