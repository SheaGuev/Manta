# Code patterns

Conventions the codebase follows. Match them when changing code; if one doesn't fit, raise it rather than working around it.

## Types and boundaries

- **Types the renderer needs live in `src/shared/ipc.ts`**, which imports nothing. Core imports them from there and re-exports where convenient (`git.ts` re-exports `FileChange`, `threads.ts` re-exports `ThreadInfo`, `threadForks.ts` re-exports `ThreadProposal`). Never the reverse.
- **The renderer has no Node access.** Everything goes through `window.manta` (`MantaApi`), implemented in `src/preload/index.ts` and handled in `src/main/index.ts`. The one exception is `src/core/threads/threads.ts`, which the renderer imports to read thread anchors from its own Yjs replica: keep that file free of Node imports.
- **Main validates every IPC argument** with small helpers (`str`, `int`, `status` in `main/index.ts`); the renderer is treated as untrusted input. Roots are checked against the project registry (`ProjectRegistry.workspace`).

## No casts

No `as` anywhere, including `as const`.

- Data from outside (JSON files, `Y.Map` values, `localStorage`, CLI output) is `unknown` until a guard narrows it: `parseEntry`, `parseRecord`, `isMessage` (`threads.ts`), `isOpenFile` / `isThreadTabValue` (`App.tsx`), `parseAuthStatus` (`claudeStatus.ts`). Guards use `typeof` and `'key' in value`.
- Literal types come from annotations, not assertions: a typed constant (`const STATUSES: readonly ThreadStatus[] = [...]`) or a return-type annotation on a callback (`.map((update): PermissionUpdate => ({ ...update, destination: 'session' }))`).
- A guard that filters an array narrows it: `messages.every(isMessage)`, `.filter((tab): tab is Tab => ...)`.

## CRDT and files

- **The CRDT is the source of truth; files are exports.** `LivingDoc.writeToDisk` writes the doc's text; thread records in `.manta/threads/` are exports of the thread index. Writers return `false` (or skip) when nothing changed, so watchers and git see no churn (`writeToDisk`, `ThreadRecordStore.write`, `recordIsStale`).
- **Every text change reaches a Y.Text as minimal ops** (`computeTextEdits` + `applyTextEdits`: line diff, then character diff inside changed hunks), so unchanged characters keep their identity and relative positions anchored to them survive.
- **Outside changes merge at a snapshot.** Fork the CRDT at the state matching the last known text, replay `last text → new text` as ops, merge the fork in (`mergeTextChange`). Used for outside edits, pulls, and the agent's edits to a thread folder.
- **Transaction origins say who made a change**: `RENDERER_ORIGIN` (not echoed back to the editor), `EXTERNAL_ORIGIN`, `LOAD_ORIGIN` (not re-persisted), `THREAD_ORIGIN`, `AGENT_ORIGIN`. Pass one on every `Y.applyUpdate` and `transact` outside the editor.
- **Anchors are relative positions, start `assoc 0`, end `assoc -1`**, stored base64-encoded (`encodePosition`) so they fit in JSON and in a `Y.Map` unchanged. A range that resolves empty means the anchored text is gone.

## Concurrency

- **One serial queue per workspace** (`Workspace.serial`) for everything that touches the working tree, git or stored state, so a debounced write can never land mid-pull or mid-approve. Thread code reaches it through `WorkspaceAccess.serial`; access methods marked "inside `serial` only" never queue, so calling them from a queued task can't deadlock.
- **Long-running work stays off the queue.** An agent turn does its setup and teardown on the queue and runs in between, so a long turn never blocks a commit. Anything it needs to change mid-turn goes back through the queue (`TurnSteps.absorbCheckout` in `threadTurns.ts`).
- **Per-file stores serialise their own I/O** (`DocStore.enqueue`).

## Disk writes

- Write to `<file>.tmp`, then `rename` (`atomicWrite` in `docStore.ts` and `threadForks.ts`).
- When several files make up one state, write the completeness marker last (`meta.json` in `DocStore`, `fork.bin` in `ThreadForkStore`), and treat a missing marker as "not saved".
- A truncated tail in an append-only log is dropped, not fatal (`decodeLog`).

## Results and errors

- **User-facing refusals return `OpResult`** (`{ ok: false, message }`): "commit them first", "no proposed change", "already merged". The UI shows the message.
- **Destructive actions check refusals before asking.** Core runs every check, then calls a `confirm` callback that main implements with a native dialog (`ProjectRegistry.removeWorktree`); a cancel returns `null`, not an error. Tests pass `async () => true` or `false`.
- **Programmer errors and impossible states throw**: unknown thread id, bad IPC argument.
- One bad file never blocks the repo: unreadable thread records are skipped with a `console.error`.

## External APIs

- **Verify option and type names from the package's own `.d.ts`** and official docs before using them; don't guess. Note the source in the plan or a comment when the reason isn't obvious.
- **Pin exact versions** of SDKs whose behaviour was verified (`@anthropic-ai/claude-agent-sdk`).
- Shell out to `git` rather than using a JS git library (`git.ts`), so worktrees, hooks, credentials and user config behave as in the terminal.

## Renderer

- **CodeMirror:** block decorations (rendered tables) come from a `StateField`; inline widgets and marks can come from a `ViewPlugin` (`threadMarkers.ts`, `livePreview.ts`). Never dispatch inside an update: changes from outside CodeMirror (the Yjs thread index) schedule a refresh with `queueMicrotask(() => view.dispatch(...))`, guarded by a liveness flag. Widgets that act on click implement `ignoreEvent()` and prevent `mousedown`, so CodeMirror doesn't move the cursor.
- **A popover attached to an editor widget renders inside the widget's DOM** (the section marker's thread list), with its open state in a `StateField` so a keymap can read it. A `mousedown` outside it or Escape closes it.
- **Pane widths are CSS variables** (`--sidebar-width`, `--panel-width`) set on `.app` from React state (`usePersistentWidth`, `ResizeHandle`), so the grid layout stays in CSS.
- **Callbacks that change every render are read through refs** (`cursorListener`, `threadHandlers` in `Editor.tsx`), so the editor isn't rebuilt.
- **IPC subscriptions return an unsubscribe function**; effects call it in their cleanup.
- **Effects use block bodies** whenever the expression could return a value: Chromium's `scrollIntoView()` returns a Promise, and React treats any returned value as the cleanup.
- Styling uses the CSS variables in `style.css` (`--bg-*`, `--text-*`, `--accent`, `--green`, `--red`, `--yellow`, `--radius`); new components reuse `.row`, `.icon-button`, `.primary-button`, `.popover`, `.badge`.

## Comments

- Default to none. Comment only a non-obvious *why* (a workaround, a constraint from an external system, a gotcha), in `/** */` style.
- JSDoc on exported functions only when the signature doesn't explain usage; one or two sentences.
- Never reference a conversation, a ticket or "as discussed".

## Tests

- **Tests live in `__tests__/` beside the code they cover** (`core/docs/__tests__/textEdits.test.ts` tests `core/docs/textEdits.ts`). Cross-module end-to-end tests sit in the nearest common folder (`core/__tests__/`).
- **Core tests use real temp git repos**: a bare `origin` plus clones (`setup` in `workspace.test.ts` / `workspaceThreads.test.ts`), with editor replicas wired to the workspace the way the renderer is. No git mocks.
- **Agents are faked with `ScriptedAgent`**, which really edits the checkout file, so the absorb path runs for real. Wait on async events with `vi.waitFor`.
- **UI is tested end to end through CDP** against an isolated instance (`MANTA_USER_DATA` in `/tmp`, `MANTA_FAKE_AGENT=1`), with screenshots checked by eye as well as DOM assertions. See `docs/threads.md` → Developing.
- **Live runs against real services spend the user's usage: ask first**, and launch them with the calling session's `CLAUDE*`/`ANTHROPIC*` variables stripped.
- **Bug reports are reproduced on a read-only copy** of the user's data in `/tmp`, never on the real vault.
