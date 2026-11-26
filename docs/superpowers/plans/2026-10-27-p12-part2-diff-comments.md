# P12 part 2: diff comments to agents. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comment on lines of any diff in Manta (the Branch tab's compare tabs and the Changes tab's diff tabs). Then send a comment to an open Claude agent straight away, or collect comments in the right panel and send them as a batch. The agent starts working, and Manta doesn't switch tabs.

**Architecture:**
- **Storage:** comments are kept per worktree in core (`ReviewCommentStore`, in the worktree's own git dir), reached through IPC.
- **Sending:** main pastes one message into the chosen Claude terminal: bracketed paste, then Enter, refused unless the session is ready. Picking "new session" instead starts one with the message as its first prompt.
- **The diff UI:** a CodeMirror extension (`commentGutter.ts`) adds a hover **+** in a gutter beside every line, including the rows of deleted chunks (through `widgetMarker`), and a comment box widget under the line.
- **The batch list:** a **Comments** section at the top of the Changes and Branch tabs. An `AgentPicker` popover chooses the agent.

**Tech Stack:** Electron, React, TypeScript, CodeMirror 6 with `@codemirror/merge` 6.12.2, node-pty with `@xterm/headless`, vitest with real temp repos and the scripted `fake-claude.mjs`.

**Spec:** [docs/superpowers/specs/2026-10-26-orca-polish-design.md](../specs/2026-10-26-orca-polish-design.md), section G-D. G-E (the PR tab) and G-F (PR review) reuse `commentGutter.ts`, `AgentPicker` and `sendReview`.

**Spike result (the spec's open question):** commenting on deleted lines is possible.
- `@codemirror/merge` renders each deleted chunk as one block widget holding one `div.cm-deletedLine` per original line (`dist/index.js`, `deletionWidget`).
- Gutters can place a marker beside a block widget (`gutter({ widgetMarker })`), which `@codemirror/merge`'s own change gutter already does.
- A marker element holding one row per deleted line, each one line tall, gives a **+** per deleted line.
- `getChunks(state)` and `getOriginalDoc(state)` (both exported) map a chunk's row to its original line.
- Both diff views are `unifiedMergeView` without line wrapping, so the rows line up.

## Global Constraints

- [docs/patterns.md](../../patterns.md): no `as` casts (including `as const`, and in tests); guards for outside data (JSON files, IPC arguments); per-file stores serialise their own I/O; atomic writes (`.tmp` then `rename`); `OpResult` for user-facing refusals; `/** */` comments only for a non-obvious why.
- [src/README.md](../../../src/README.md) boundaries: the renderer reaches main only through `window.manta`, `shared/` imports nothing, `core/` never imports Electron.
- A new folder gets a `README.md`. A new, renamed or removed file updates its folder's README table in the same task (`directoryReadmes.test.ts` enforces it).
- Before calling a task done: `npm run typecheck` and `npm test` pass.
- UI checks run on an isolated build, never the user's profile:
  - Copy the repo to the scratchpad, symlink `node_modules` into it, and run `npm run build` there.
  - Launch with `MANTA_USER_DATA=<scratch>/profile MANTA_FAKE_AGENT=1 ./node_modules/.bin/electron . --remote-debugging-port=9351`.
  - Drive it over CDP and look at the screenshots.
- No live Claude Code runs. They spend the user's usage, and the fake agent covers the tests.
- Git: work on branch `p12-part2`. Stage each task's files and don't commit until the user asks. The user said yes to commit-and-merge for part 1 only.
- UI is minimal and clean in Manta's style. Reuse `.row`, `.icon-button`, `.popover`, `.quick-open-row`, `.badge` and the `--bg-*` / `--text-*` / `--accent` variables.
- Sending never switches tabs or contexts.
- These comments never go to GitHub.

## Review Focus

1. **A session that isn't ready** (still starting, waiting on a permission prompt, exited, or without bracketed paste on): sending is refused with a message and nothing is typed into it. A paste into a permission prompt would answer it. Pinned in Task 2.
2. **A multi-line comment** reaches the agent as one prompt, not one prompt per line. Pinned in Task 2 (the fake agent sees one `UserPromptSubmit`).
3. **A corrupt or hand-edited comments file:** the list reads as empty and unparseable entries are skipped; the next write rewrites the file cleanly. Pinned in Task 1.
4. **A comment on a deleted line:** it anchors to the old side with the original line number and text, and its hunk shows the `-` line. Pinned in Task 4.
5. **The diff changed since the comment was made:** the comment is kept and shows as outdated, not lost or misplaced. Pinned in Task 4 (`placeComments`).

---

### Task 1: The comment store and the message format (core)

**Files:**
- Create: `src/core/review/reviewComments.ts`, `src/core/review/reviewMessage.ts`, `src/core/review/README.md`
- Test: `src/core/review/__tests__/reviewComments.test.ts`, `src/core/review/__tests__/reviewMessage.test.ts`
- Modify: `src/shared/ipc.ts` (types), `src/core/README.md` (the new folder's row)

**Interfaces:**
- Produces, in `shared/ipc.ts`:

```ts
export type ReviewDiff = 'changes' | 'branch'
export interface ReviewAnchor { relPath: string; diff: ReviewDiff; side: 'old' | 'new'; line: number; lineText: string; hunk: string }
export interface ReviewComment extends ReviewAnchor { id: string; body: string; createdAt: string; sent: { to: string; at: string } | null }
export type ReviewTarget = { terminal: string } | { newSession: true }
```

- Produces `class ReviewCommentStore`:
  - `constructor(file: () => Promise<string>)`. The file path is resolved lazily.
  - `list(): Promise<ReviewComment[]>`
  - `add(anchor: ReviewAnchor, body: string): Promise<ReviewComment>`
  - `edit(id: string, body: string): Promise<void>`
  - `remove(ids: readonly string[]): Promise<void>`
  - `markSent(ids: readonly string[], to: string): Promise<void>`
  - Ids are `rc_<12 hex>`. Every method runs on the store's own promise queue. Writes are atomic, as `{ "comments": [...] }`, pretty-printed with a trailing newline.
  - `parseComment(value: unknown): ReviewComment | null` is exported. Unreadable entries are skipped with `console.error`.
- Produces `formatReviewMessage(comments: readonly ReviewComment[], where: string): string` in `reviewMessage.ts`:

````
Review comments on your changes in <where>:

1. <relPath>:<line> (old side, removed line)      ← "(old side, removed line)" only when side is 'old'
```diff
<hunk>
```
<body>

2. …
````

  Comments are numbered in list order, separated by a blank line. The fence length grows past any backtick run in the hunk, the way `fenced` in `core/threads/implementationBrief.ts` does it (reuse it).

- [ ] **Step 1: Write the failing tests**
  - `reviewComments.test.ts`, against a temp dir:
    - `it('adds, edits, marks sent and removes comments, and survives a reopen')`
    - `it('reads a corrupt file as empty and rewrites it on the next add')`: write `{not json`, then `list()` → `[]`, then `add` → the file parses.
    - `it('skips entries that are not comments')`: write `{"comments":[{"id":"rc_x"}, <valid>]}`, then `list()` returns the valid one.
    - `it('queues concurrent adds so none is lost')`: `Promise.all` of 5 adds → `list()` has 5.
  - `reviewMessage.test.ts`:
    - `it('numbers comments with their place, hunk and body')`, with the exact text above for two comments, one of them old-side.
    - `it('fences a hunk that contains backticks')`

- [ ] **Step 2: Run them and check that they fail.** Run: `npx vitest run src/core/review`. Expected: FAIL, because the modules aren't found.

- [ ] **Step 3: Implement both modules and the shared types.** Write `src/core/review/README.md` with a table row per file, plus Imports and Tests lines in the style of `core/maps/README.md`. Add the folder to `src/core/README.md`.

- [ ] **Step 4: Run them and check that they pass.** Run: `npx vitest run src/core/review`, then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Stage** `src/core/review src/core/README.md src/shared/ipc.ts`.

### Task 2: Pasting a prompt into a Claude session (core terminal)

**Files:**
- Modify: `src/core/terminal/terminalHost.ts` (`pasteReady(id): boolean`), `src/core/terminal/terminals.ts` (`sendPrompt`), `scripts/fake-claude.mjs`, `src/core/terminal/README.md`, `docs/terminals.md` (a Flows subsection, "Sending a prompt")
- Test: `src/core/terminal/__tests__/terminals.test.ts`

**Interfaces:**
- Produces `TerminalHost.pasteReady(id: string): boolean`: the headless screen's `modes.bracketedPasteMode` (`@xterm/headless`), false for an unknown or exited session.
- Produces `TerminalManager.sendPrompt(id: string, text: string): Promise<OpResult>`:
  - **Refusals** (`ok: false`, nothing written):
    - not a Claude terminal: "Only Claude sessions take review comments"
    - `exited` or `starting`: "<title> isn't running" / "<title> is still starting"
    - `waiting`: "<title> is waiting for you; answer it first"
    - `!pasteReady`: "<title> is still starting"
  - **Otherwise:** write `\x1b[200~${text}\x1b[201~`, wait 50 ms, write `\r`, and return `{ ok: true, message: 'Sent to <title>' }`. Orca does the same, `AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS = 50` in its `shared/agent-prompt-injection.ts`. `working` and `idle` both accept, since Claude Code queues a message sent while it works.
- `fake-claude.mjs` changes:
  - It prints `\x1b[?2004h` once at start, as Claude Code's TUI does.
  - A line containing `\x1b[200~` starts a paste. Lines are collected until one containing `\x1b[201~`.
  - The markers are stripped and the joined text (newlines kept) is handled as **one** prompt when the closing line ends. That fires one `UserPromptSubmit` and replies `Scripted reply to: <first line>`.

- [ ] **Step 1: Write the failing tests** in `terminals.test.ts`, using the existing `open` harness and `slow` waits:
  - `it('sends a multi-line prompt to an idle Claude session as one prompt, and it starts working')`
    - Wait for `idle`, then `sendPrompt(id, 'line one\nline two')` → `ok: true`.
    - The output gets `Scripted reply to: line one` exactly once.
    - The changes include a `working` state for that id.
  - `it('refuses a session waiting on a permission prompt, and writes nothing')`
    - Write `ask ls\r`, wait for `waiting`, then `sendPrompt` → `ok: false` with "waiting for you".
    - The output after that call doesn't contain the text.
  - `it('refuses shells and exited sessions')`

- [ ] **Step 2: Run them and check that they fail.** Run: `npx vitest run src/core/terminal/__tests__/terminals.test.ts`. Expected: the new tests fail (`sendPrompt` is not a function).

- [ ] **Step 3: Implement** `pasteReady`, `sendPrompt` and the fake-claude changes. Check that the existing fake-claude tests still pass: the start-up escape mustn't break assertions on its output.

- [ ] **Step 4: Run them and check that they pass.** Run: `npx vitest run src/core/terminal`. Expected: PASS.

- [ ] **Step 5: Update the docs and stage.**
  - `docs/terminals.md`: a "Sending a prompt" subsection covering bracketed paste, the refusals and why `waiting` is refused.
  - The terminal README rows.
  - Stage the files.

### Task 3: Sending comments, and the IPC (core + main)

**Files:**
- Create: `src/core/review/sendReview.ts`
- Test: `src/core/review/__tests__/sendReview.test.ts`
- Modify: `src/core/workspace.ts` (a `review` store per workspace), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/core/review/README.md`

**Interfaces:**
- Consumes: `ReviewCommentStore`, `formatReviewMessage` (Task 1); `TerminalManager.sendPrompt` and `create` (Task 2).
- Produces `Workspace.review: ReviewCommentStore`, whose file is `path.join(await git.gitDir(), 'manta', 'review-comments.json')`.
  - `--git-dir` is per worktree (`.git/worktrees/<name>`), so each worktree has its own file, and removing the worktree removes it.
  - This replaces the spec's `<git-common-dir>/manta/review-comments/<name>.json` with the same intent. Record a ruling.
- Produces `sendReview({ store, terminals, root, ids, target, size }): Promise<OpResult>`:
  - Takes the stored comments with those `ids` (unknown ids are ignored; none left → `ok: false`, "Nothing to send").
  - Formats the message with `where = path.basename(root)`.
  - For `{ terminal }`, it calls `sendPrompt`. For `{ newSession: true }`, it calls `terminals.create(root, 'claude', size, { prompt: message })`.
  - On success it calls `markSent(ids, <terminal title>)` and returns the `OpResult`.
  - `terminals` is typed as `Pick<TerminalManager, 'sendPrompt' | 'create' | 'list'>`.
- Produces the IPC, with main validating each argument:
  - `reviewComments(root)`
  - `addReviewComment(root, anchor: ReviewAnchor, body)`, through a guard `reviewAnchor(value: unknown)` in main
  - `editReviewComment(root, id, body)`
  - `removeReviewComments(root, ids)`
  - `sendReviewComments(root, ids, target: ReviewTarget)`
  - `onReviewCommentsChanged(listener: (root: string) => void)`, sent by main after every add, edit, remove or send
  - Channels: `review:list`, `review:add`, `review:edit`, `review:remove`, `review:send`, `review:changed`.

- [ ] **Step 1: Write the failing tests** in `sendReview.test.ts`, with a real `TerminalManager` running fake-claude (copy the harness setup from `terminals.test.ts`) and a `ReviewCommentStore` in a temp dir:
  - `it('pastes the formatted comments into the chosen session and marks them sent to it')`: the output contains `Review comments on your changes in`, and `list()` shows `sent.to === 'Claude'`.
  - `it('starts a new session with the comments as its first prompt')`: a new Claude terminal appears in `list()`, its output has the message's first line, and the comments are marked sent.
  - `it('leaves comments unsent when the session refuses')`: an exited terminal → `ok: false`, and `sent` stays null.

- [ ] **Step 2: Run them and check that they fail.** Run: `npx vitest run src/core/review/__tests__/sendReview.test.ts`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `sendReview`, `Workspace.review` and the IPC.** Main's send handler uses `INITIAL_TERMINAL`-like defaults `{ cols: 120, rows: 32 }` for a new session's size. The tab's view refits on mount.

- [ ] **Step 4: Run and check.** `npx vitest run src/core/review && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Stage.**

### Task 4: Anchors, hunks and agent order (renderer, pure)

**Files:**
- Create: `src/renderer/src/lib/reviewAnchors.ts`, `src/renderer/src/lib/agentTargets.ts`
- Test: `src/renderer/src/lib/__tests__/reviewAnchors.test.ts`, `src/renderer/src/lib/__tests__/agentTargets.test.ts`
- Modify: `src/renderer/src/lib/README.md`

**Interfaces:**
- Produces in `reviewAnchors.ts`. Each one works on an `EditorState` built with `unifiedMergeView({ original })`, which runs in Node because only `getChunks` / `getOriginalDoc` state is read:
  - `newLineAnchor(state, lineNumber: number): Omit<ReviewAnchor, 'relPath' | 'diff'>`: side `'new'`, the line's text, and a hunk of up to 2 lines of context either side. The hunk prefixes lines with `+` when they're inside a chunk's B range, `' '` otherwise, plus the chunk's deleted lines as `-` where they fall.
  - `deletedRowAnchor(state, chunkFromB: number, row: number): Omit<ReviewAnchor, 'relPath' | 'diff'> | null`: side `'old'`. `line` is `originalDoc.lineAt(chunk.fromA).number + row`, with that line's text. The hunk is centred on it the same way. Null when no chunk starts at `chunkFromB` or `row` is out of range.
  - `placeComments(state, comments: readonly ReviewComment[]): { comment: ReviewComment; pos: number; outdated: boolean }[]`:
    - A new-side comment goes at the end of its line.
    - An old-side comment goes at the deletion widget's position (`chunk.fromB`) of the chunk whose A range holds its line.
    - It's `outdated` when the text at that line no longer equals `lineText`, or the line is gone. Then it's placed at the nearest line that exists.
- Produces in `agentTargets.ts`: `agentTargets(terminals: readonly TerminalInfo[], root: string): { terminal: TerminalInfo; sameRoot: boolean; sendable: boolean; reason: string | null }[]`
  - Claude terminals only, with exited ones left out.
  - Same root first, then the rest by `startedAt ?? createdAt`, newest first.
  - `sendable` is false with the reason "Waiting for you" for `waiting` and "Starting" for `starting`.

- [ ] **Step 1: Write the failing tests.** Use original `'a\nb\nc\nd\n'` and current `'a\nB\nc\nd\ne\n'`, so b becomes B (a changed chunk: deleted row `b`, inserted `B`) and `e` is added.
  - `newLineAnchor(state, 2)` → `{ side: 'new', line: 2, lineText: 'B' }`, with a hunk equal to `' a\n-b\n+B\n c\n d'`.
  - `deletedRowAnchor(state, <chunk.fromB>, 0)` → `{ side: 'old', line: 2, lineText: 'b' }`, whose hunk contains `-b`. Row 1 → null.
  - `placeComments`:
    - A new-side comment on line 5 `'e'` sits at the end of line 5 and isn't outdated.
    - The same comment with `lineText: 'x'` is outdated.
    - An old-side comment on line 2 sits at the chunk's `fromB`.
    - A comment on line 99 is outdated and placed on the last line.
  - `agentTargets`:
    - Order: same root first, then newest.
    - Exited sessions and shells are excluded.
    - Waiting and starting sessions are listed but not sendable, with their reasons.

- [ ] **Step 2: Run them and check that they fail.** Run: `npx vitest run src/renderer/src/lib/__tests__/reviewAnchors.test.ts src/renderer/src/lib/__tests__/agentTargets.test.ts`. Expected: FAIL, because the modules aren't found.

- [ ] **Step 3: Implement both.** If `unifiedMergeView`'s state fields don't initialise on a bare `EditorState`, record it as a ruling. Then build the chunks with `Chunk.build(original, current)` from `@codemirror/merge` and pass them in, so the functions take `{ chunks, original }` instead of a state.

- [ ] **Step 4: Run them and check that they pass.** The same command. Expected: PASS.

- [ ] **Step 5: Add the README rows and stage.**

### Task 5: The comment gutter, the comment box and the agent picker (renderer UI)

**Files:**
- Create: `src/renderer/src/lib/commentGutter.ts`, `src/renderer/src/components/AgentPicker.tsx`
- Modify: `src/renderer/src/components/CompareView.tsx`, `src/renderer/src/components/Editor.tsx` (diff mode only), `src/renderer/src/lib/hooks.ts` (`useReviewComments`), `src/renderer/src/style.css`, both READMEs

**Interfaces:**
- Consumes: `newLineAnchor`, `deletedRowAnchor`, `placeComments`, `agentTargets` (Task 4); the review IPC (Task 3).
- Produces `commentGutter(handlers: { current: CommentHandlers }): Extension`, where:

```ts
interface CommentHandlers {
  /** Saves a new comment; `send` also opens the agent picker for it at `rect`. */
  onSave: (anchor: Omit<ReviewAnchor, 'relPath' | 'diff'>, body: string, send: { rect: DOMRect } | null) => void
  onRemove: (id: string) => void
}
export const setReviewComments: StateEffectType<readonly ReviewComment[]>
```

  Handlers are read through a ref, as `threadHandlers` in `Editor.tsx` is, so the view isn't rebuilt.

- The extension's parts:
  - **Hover tracking.** A `ViewPlugin` follows `mousemove` over `.cm-line` and `.cm-deletedLine`. It stores `{ line } | { chunkFromB, row } | null` in a `StateField` through an effect, scheduled with `queueMicrotask` and never dispatched inside an update.
  - **The gutter.** `gutter({ class: 'cm-commentGutter', lineMarker, widgetMarker, lineMarkerChange })`:
    - `lineMarker` shows a **+** on the hovered line.
    - `widgetMarker` returns, for a deletion widget, an element with one row per deleted line (`.cm-commentRow`, each `height: var(--line-height)`, measured from `view.defaultLineHeight`), the hovered row showing **+**.
    - Clicking a **+** opens the comment box for that anchor.
    - Markers implement `ignoreEvent`-equivalent handling: `mousedown` is prevented so the cursor doesn't move.
  - **The comment box.** A block widget under the line, or after the deletion widget for an old-side row, from a `StateField`. It holds a `textarea` and three controls:
    - **Comment** (`onSave(…, null)`)
    - a send icon (`onSave(…, { rect })`)
    - **Cancel**
    - Escape cancels and ⌘Enter saves. Widgets prevent `mousedown` and implement `ignoreEvent() { return true }`.
  - **Saved comments.** Block widgets from `placeComments`, read-only and compact: a muted body, "outdated" as a `.badge` when it is, "sent to <title>" when sent, and an × that calls `onRemove`.
- Produces `AgentPicker({ root, anchorRect, onPick, onClose }: { root: string; anchorRect: DOMRect; onPick: (target: ReviewTarget) => void; onClose: () => void })`:
  - A fixed-position `.popover` listing `agentTargets(useTerminals() ?? [], root)`, each row showing its title, its context's folder name and the `terminal-dot state-<state>` dot. Disabled rows show their reason.
  - The last row is **New Claude session here** (`{ newSession: true }`).
  - ↑/↓/Enter/Escape work as in `BranchPicker`.
- Produces `useReviewComments(root: string | null): ReviewComment[]`: `useRootData` with `refreshOn: never` and a version bumped by `onReviewCommentsChanged` for that root.
- Wiring:
  - `CompareView` and the editor's diff mode add `commentGutter`. Both need `relPath` and `diff` (`'branch'` for `CompareView`, `'changes'` for diff mode).
  - On save, they call `api.addReviewComment(root, { ...anchor, relPath, diff }, body)`.
  - With `send`, the saved comment's id plus the rect open `AgentPicker`. Each view renders it itself, in a portal-free fixed `div`.
  - Picking calls `api.sendReviewComments(root, [id], target)`. The `OpResult` message goes to the existing error and message path (`onError`, or a new `onMessage` prop where the view has none).
  - The diff dispatches `setReviewComments` with the comments for its `relPath` and `diff` whenever `useReviewComments` changes.

- [ ] **Step 1: Build the extension and the picker.** Run `npm run typecheck`; expect it to pass.

- [ ] **Step 2: Check by eye on the isolated build** (code project plus worktree, as in part 1):
  - Commit a change that edits one line and deletes another.
  - Open its compare tab from the Branch tab.
  - Hovering shows the **+** in the gutter on new lines and on the deleted row.
  - Add a comment on the deleted row: it's saved with `side: 'old'` (check `review:list` through CDP).
  - Then use the send icon → the picker lists the worktree's fake Claude first.
  - Send it: the agent's tab, not the active one, goes to `working` in the sidebar dot, and the active tab doesn't change.
  - Repeat once in a Changes-tab diff.
  - Take screenshots of the hover, the box, the saved comment and the picker.

- [ ] **Step 3: Update the READMEs and stage.**

### Task 6: The Comments section and the batch send (renderer UI + docs)

**Files:**
- Create: `src/renderer/src/components/ReviewComments.tsx`
- Modify: `src/renderer/src/components/ChangesPanel.tsx`, `src/renderer/src/components/BranchPanel.tsx` (render it at the top), `src/renderer/src/components/RightPanel.tsx` (pass `root`, open callbacks), `src/renderer/src/style.css`, components README
- Create: `docs/reviews.md`. Modify: `docs/roadmap.md` (mark the P12 bullet built), `CLAUDE.md` (add `docs/reviews.md` to the deep dives), `src/core/review/README.md` if it changed

**Interfaces:**
- Consumes: `useReviewComments`, `AgentPicker`, the review IPC.
- Produces `ReviewComments({ root, diff, onOpen }: { root: string; diff: ReviewDiff; onOpen: (comment: ReviewComment) => void })`:
  - It renders nothing when there are no comments of that `diff`.
  - Otherwise there's a `ChangeSection`-styled header **Comments** with a count, then one row per comment:
    - a checkbox (unsent ones checked by default)
    - `file:line` and the body's first line
    - "sent to <title>", greyed, when sent
    - an × to delete
  - A footer has **Send N to agent…** (the checked unsent comments, opening `AgentPicker`) and **Clear sent** (removes every sent one).
  - Clicking a row calls `onOpen`. `RightPanel` maps that to `onOpenDiff(relPath)` for `'changes'` and to `onOpenCompare(relPath, base.sha, head, …)` for `'branch'`.
- `docs/reviews.md` covers what review comments are, where they're stored, the message format, sending (refusals, no tab switch, new session), and the UI parts with their files. It also notes that G-E and G-F extend it.

- [ ] **Step 1: Build `ReviewComments` and wire it into both tabs.** Run `npm run typecheck`; expect it to pass.

- [ ] **Step 2: Check by eye.**
  - Add three comments across two files in the Branch diff.
  - The Branch tab lists them, and the Changes tab doesn't. Then the reverse for a Changes-diff comment.
  - Uncheck one and send 2: the fake agent gets one prompt numbered 1–2, both rows show "sent to Claude", and the unchecked one stays unsent.
  - **Clear sent** removes the two.
  - Clicking a row opens its diff.
  - Take a screenshot of the section.

- [ ] **Step 3: Write `docs/reviews.md` and the roadmap and `CLAUDE.md` lines. Run** `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 4: Stage.**

---

## Self-review notes

- **Spec coverage (G-D):** every diff (compare and Changes diff), the hover **+**, the box under the line, send one comment straight away, collect and batch-send from the right panel, the picker (all open Claude agents, same worktree first, waiting ones disabled, new session when there are none), submitting so the agent starts working, no tab switch, no template, kept in Manta only, the message format, bracketed paste plus Enter, sent marking, edit and delete before sending, outdated comments kept, storage per worktree, and deleted-line comments (the spike result).
- **Deviations, each needing a ruling:**
  - The storage path is the worktree's own git dir instead of `<git-common-dir>/manta/review-comments/<name>.json`. It has the same intent and is cleaned up with the worktree.
  - Sent comments stay greyed until **Clear sent** rather than also "dropping off after a while". That's one rule instead of a timer.
  - Editing a comment's body happens through `editReviewComment`. The UI for it is the saved comment widget's click-to-edit. If that adds much to Task 5, fall back to delete and re-add, and record the ruling.
