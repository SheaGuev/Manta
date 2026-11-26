# Threads inside docs

How threads work in Manta, for anyone changing them. Built in step 2 (commits `6d586d5` to `b2d45d0`). This file describes the code as it is. The decision history (D13 to D34, Q6 to Q13, risks R7 to R26) and the CDP dev scripts are kept outside the repo and are not published.

## What a thread is

A thread is a conversation pinned to a section of a doc. The user starts it on a section, talks to an agent (the user's own Claude Code), and the agent proposes an edit. The proposal lives in a copy of the doc; nothing touches the real doc until the user approves. Approving merges the proposal into the doc and makes one git commit with a `Manta-Thread: <id>` trailer. Threads are never deleted: they end up merged, discarded or detached, and stay reachable from the doc.

Invariant everything below protects: **the doc only changes through an approved fork.** The agent writes to its own copy; file tools are fenced by a hook, Bash by the OS sandbox.

## Data model

```
doc (LivingDoc, one Y.Doc per markdown file)
 ├─ Y.Text 'md'          the markdown
 ├─ Y.Map  'actors'      client id → who made an outside change
 └─ Y.Map  'threads'     the thread index: id → ThreadEntry
       { title, status, parent, createdAt,
         anchor: { start, end } | null,          relative positions, base64
         landed?: [{ start, end, removed }] }    what approving changed, until hidden

thread fork (ThreadFork, one Y.Doc per thread)
   a copy of what the thread merges into (the doc, or the parent thread's fork),
   taken when the thread starts; the agent's and the user's edits land here
```

| Status | Meaning |
|---|---|
| `open` | Taking messages and edits |
| `approved` | A subthread merged into its parent's proposal; not in the doc yet |
| `merged` | Landed in the doc and committed |
| `discarded` | Closed without merging; still listed and anchored |
| detached | Not a status: the anchor resolves to an empty range because the section was deleted. `ThreadInfo.range` is `null` |

### Anchors

`ThreadIndex` (`src/core/threads/threads.ts`) anchors a thread to a section with two Yjs relative positions: start sticks to the first character (`assoc 0`), end to the last (`assoc -1`), so typing just outside the section never widens it. Because every edit reaches the CRDT as minimal ops (in-app typing, outside edits and pulls alike, via `computeTextEdits` in `src/core/docs/textEdits.ts`), unchanged characters keep their identity and anchors follow them.

`sectionAt(markdown, offset)` decides what "the section" is: the enclosing heading down to the next heading of the same or higher level, or the paragraph when no heading encloses it, trailing blank lines dropped, `#` lines inside fences ignored.

### Where things are stored

| What | Where | Committed? |
|---|---|---|
| Doc CRDT (update log + snapshots) | `<repo>/.git/manta/docs/<encoded path>/` | No |
| Thread record: title, status, parent, anchor (CRDT positions + quote), transcript | `<repo>/.manta/threads/<id>.json` | No: `.manta/` is kept out of git |
| Thread fork: fork point, fork state, last checkout snapshot, Claude Code session id | `<repo>/.git/manta/threads/<id>/` (`base.bin`, `fork.bin`, `checkout.bin`, `checkout.txt`, `session.txt`) | No |
| Thread folder: the agent's working directory, holding one file (the doc, by basename) | `<userData>/threads/<id>/` | No |

The folder can't live under `.git/`: Claude Code treats `.git` as a protected path.

### Records, `.manta/` and fresh clones

The record (`ThreadRecordStore`, `src/core/threads/threadRecords.ts`) is an export of the CRDT entry, the way the `.md` file is an export of `Y.Text`. It is written on create, status change, each agent turn (transcript) and on commit. A record is only rewritten when its quoted text, title, status, parent or messages change (`recordIsStale`): CRDT positions differ per machine and the quote's 32-character context shifts with nearby edits, and neither is worth a rewrite.

`.manta/` is Manta's own folder and never reaches git: `Workspace.open` adds `/.manta/` to `.git/info/exclude` (local, never committed), and the workspace's `Git` hides `.manta` from status, diff stats, `hasChanges` and commit-all, so records a repo tracked from before stay out of new commits too. Users don't commit threads; how records travel between machines is Manta's job: its own git ref next, a cloud store with accounts later (roadmap P7). Until then a fresh clone has no records.

A repo with records but no `.git/manta/` (records copied in, or CRDT state lost), so CRDT positions in records don't resolve. `Workspace.open` adopts every top-level record (`threads.adoptRecords`, then `ThreadIndex.adopt`): first the record's own positions, then `findQuote`, which scores each exact match of the quoted text by how much of the recorded prefix and suffix surrounds it. Subthread records are adopted lazily into their parent's fork when first looked up. A fresh clone also has no fork state: an open thread's fork restarts from the current doc, so an unapproved proposal from another machine is lost.

Unparseable record files are skipped with a console error rather than blocking the repo.

Two optional fields belong to implementation threads ([implementation-threads.md](implementation-threads.md)):
- `implementation`: the thread is an implementation thread.
- `proposedBy: { doc, thread }`: the implementation session that proposed this thread's edit. Only that implementation's sessions can revise or withdraw it ([implementation-threads.md](implementation-threads.md)).

Records without them are ordinary doc threads.

## Flows

All disk and git work in a `Workspace` (`src/core/workspace.ts`) runs through one serial queue (`serial`), so a debounced write can never land in the middle of a pull or an approve. Thread operations live in `WorkspaceThreads` (`src/core/workspaceThreads.ts`, reached as `workspace.threads`), which uses the same queue through `WorkspaceAccess`. Agent turns run in `ThreadTurns` (`src/core/threadTurns.ts`) and are the exception, described below.

### Create

`threads.createAt(relPath, offset, title)` runs `sectionAt` on main's copy of the doc (never the renderer's offsets into possibly stale text), then `threads.create` adds the entry, writes the record and creates the fork with `ThreadFork.from(doc.ydoc)`.

### Agent turn

`threads.send(relPath, id, text)`, run by `ThreadTurns`. Steps 1 and 3, and each absorb, are `TurnSteps` that `WorkspaceThreads` provides, so the turn never reaches the fork or record directly:

1. On the serial queue: check the thread is open, absorb any leftover edits in the thread folder (the app quit mid-turn), write the fork's text to `<userData>/threads/<id>/<basename>` (`ThreadFork.checkOut` records the snapshot), append the user message to the record, and gather context (title, section text, docs repo root). For a subthread, also write its ancestors' conversations (user and agent messages, from their records, outermost first) to `.manta/parent-threads.md` in the thread folder, so the agent sees what the parent has discussed up to this turn; it sits in a subfolder so it can't collide with the doc's checkout.
2. Off the queue: `agent.run(turn)` streams `AgentEvent`s. Each `tool-done` triggers `absorbCheckout`, which diffs the file against the last checkout and merges the change into the fork as minimal ops (`mergeTextChange`, the same fork-at-snapshot merge LivingDoc uses for outside edits), so concurrent user edits to the fork survive.
3. On the queue again: a final absorb, then the turn's assistant text, tool lines and status lines are appended to the record.

One turn per thread at a time. `threads.cancel` aborts; edits already made stay in the proposal. Tool paths inside the thread folder are shown relative to it (both the plain and the resolved path: Claude Code reports `/private/tmp/...` on macOS).

Permission requests: the turn gets a `requestPermission` callback. The workspace emits a `permission` event with a request id and waits for `threads.answerPermission(threadId, requestId, decision)`; cancelling the turn, or the turn ending, resolves every pending request as `deny`. Each decision is noted in the transcript.

### Approve

`threads.approve(relPath, id)` for a top-level thread:

1. Refuse unless the thread is open, its fork has a change, and none of its subthreads are open.
2. Absorb any outside edit, then refuse if the doc differs from HEAD at all ("commit them first"), so the commit and its trailer carry only the thread's change.
3. Merge: `Y.applyUpdate(doc, fork.updateFor(doc))` applies exactly the fork's ops the doc doesn't have. Edits the doc received meanwhile survive.
4. In one transaction: status `merged`; every `approved` descendant becomes `merged`; `setLanded` records `changedRanges(before, after)`, which is exactly the thread's change because step 2 guaranteed `before` was HEAD.
5. Write the doc now (not via the debounce), rewrite stale records of every thread in the doc (locally), and `git.commitPaths([doc], 'docs(<path>): <title>\n\nManta-Thread: <id>')`. `commitPaths` uses `git add -- <paths>` then `git commit --only`, so other staged or modified files are left as they were.

`threads.proposal` returns `{ base, proposed, current, merged }`: `base → proposed` is the thread's own edit, `current → merged` is what approving does now. The UI shows the latter, so a big concurrent change is visible before approving. `threads.landed` finds a merged thread's commit by its trailer and returns the doc before and after it.

### Subthreads

A subthread's entry lives in its **parent's fork** index, anchored to the parent's section as the parent currently proposes it; its own fork is a fork of the parent's fork. `Workspace.locate(relPath, id)` finds any thread at any depth: the doc's index if it has the entry (it wins once a parent has merged, because that copy is current), otherwise the record's `parent` chain through the parents' forks. Every thread method goes through `locate` and `fork(relPath, id)`.

Approving a subthread merges its fork into the parent's fork and sets `approved`; nothing is committed. When the parent is approved, the merge carries the subthread entries into the doc's index (their anchors are CRDT items the merge brings along), and they become `merged` in the same commit. Subthreads have no doc markers and aren't in the panel list; they're reached from their parent's view. A subthread always covers the parent's whole section.

## The agent

`ThreadAgent` (`src/core/agent/threadAgent.ts`) is the interface: `run(turn) → AsyncIterable<AgentEvent>` with events `session`, `text`, `tool`, `tool-done`, `error`. Two implementations:

- **`ClaudeCodeAgent`** (`src/core/agent/claudeCodeAgent.ts`): the user's own Claude Code through `@anthropic-ai/claude-agent-sdk` (pinned, exact version). `main` finds `claude` through the user's login shell on the first turn (an app launched from the Dock has a minimal PATH) and falls back to the binary bundled with the SDK. Each turn resumes the thread's previous session.
- **`ScriptedAgent`**: a test and e2e stand-in that plays a script and makes real edits to the checkout file, so the absorb path is exercised for real. Steps: `{ text }`, `{ edit: { find, replace } }`, `{ ask: { tool, summary } }`, `{ waitForCancel: true }`. `MANTA_FAKE_AGENT=1` makes `main` use one: a message `find => replace` edits the doc, `ask <command>` requests permission, anything else gets a scripted reply.

### What a thread agent can do (`claudeCodeOptions`)

A thread runs as a normal Claude Code session with writes confined to its folder. Option names are from the SDK's `sdk.d.ts` and the permissions and sandboxing docs, not guessed.

| Option | Effect |
|---|---|
| `tools: { type: 'preset', preset: 'claude_code' }` | All built-in tools: Bash, web, subagents, skills |
| `settingSources: ['user']` | The user's plugins, MCP servers, skills, hooks, `CLAUDE.md`, model and login (Bedrock setups live in `~/.claude/settings.json`) |
| `hooks.PreToolUse: [fence]` | Denies `Edit`, `Write`, `MultiEdit`, `NotebookEdit` outside the thread folder, after resolving symlinks. Hooks run before every other permission step and a hook deny beats any allow rule |
| `sandbox: { enabled, failIfUnavailable, autoAllowBashIfSandboxed, allowUnsandboxedCommands: false }` | OS-level sandbox for Bash: writes only to the working directory and a per-user temp folder. `allowUnsandboxedCommands: false` disables the unsandboxed retry, which a matching allow rule would otherwise approve silently |
| `permissionMode: 'default'` | Explicit: omitting it can start in `auto` |
| `canUseTool` | `Read`, `Glob`, `Grep` are allowed anywhere; fenced writes are denied; everything else that needs approval goes to `requestPermission` (Allow / Always for this thread / Deny). "Always" applies the SDK's suggested rules with `destination: 'session'`, never to the user's settings files |
| `systemPrompt: { preset: 'claude_code', append }` | Tells the agent the thread title, the section, that its working directory holds a copy of the doc to edit, where the docs repo is, and that writes elsewhere are refused. A subthread's agent is also told it's a subthread of which threads, that its copy is the parent's proposal, and to read `.manta/parent-threads.md` when the parent's discussion matters |
| `includePartialMessages: true` | Text arrives as `stream_event` deltas, so the reply streams into the thread view; `eventsFrom` takes text only from the deltas and only tool calls from complete assistant messages, so nothing is counted twice |

Why the fence is a hook and not just `canUseTool`: calls approved earlier in the permission order (reads inside the working directory, read-only Bash, allow rules) never reach `canUseTool`. MCP servers and hooks run outside the Bash sandbox; their calls go through normal permissions, so the user's own allow rules apply as in a normal session. The user's hooks also run inside threads.

### Claude Code status

`claudeCodeStatus(executable)` (`src/core/agent/claudeStatus.ts`) runs `claude --version` and `claude auth status --json` (`loggedIn`, `authMethod`, `apiProvider`). The status bar's **Claude Code** item (`ClaudeStatus.tsx`) shows it, with **Check again** and **Sign in** (`claude auth login`, only when signed out).

## Renderer

| Piece | File | What it does |
|---|---|---|
| Tabs | `App.tsx` | Files and threads as tabs (`tabKey`). Opening a file or thread adds a tab; an open tab is focused, not duplicated. Drag a tab to reorder it (`lib/tabOrder.ts`; a line shows where it lands). Each tab's top edge and icon are coloured by kind: grey for files (docs, code, diffs and other views), green for shells, violet for agents (Claude sessions and threads). Each context (the docs repo, each worktree) keeps its own tab set (`tabSets`, restored on relaunch), so switching swaps sets. **Back** and **Forward** (header arrows, ⌘[ / ⌘], the mouse's side buttons) move through one in-memory history of places (a context and its active tab) for the whole window, so Back can return to another worktree; a closed tab is reopened, and places whose worktree, map or terminal is gone are skipped, as are places that would show what's already showing, so a step never seems to do nothing (`lib/navHistory.ts`). The current context's tabs stay mounted, so a running thread keeps streaming while you switch tabs |
| Threads panel | `ThreadList.tsx`, `useThreads` | The open doc's top-level threads grouped Open / Merged / Discarded / Detached, and **New thread on this section** (cursor offset from the editor) |
| Thread view | `ThreadView.tsx` | Anchored section, transcript (live from `thread:event`; assistant replies render as markdown with `streamdown`, words fading in while the turn runs), composer with Stop, permission cards, Discard in the header. The proposed-edit card appears only once there is an edit: a slim header with +/− line counts (`lib/diffStats.ts`) and Approve (jumps to the doc on success), over a read-only diff of current → merged in the doc's font. Subthreads list, parent link. A merged thread's card shows its commit and its committed diff |
| Editor markers | `lib/threadMarkers.ts` | One marker per section in the right margin of the section's first line (`sectionMarkers`: top-level threads grouped by the line their anchor starts on), drawn from the editor's own Yjs replica (`ThreadIndex` imported into the renderer; keep `core/threads/threads.ts` free of Node imports). "+ thread" on heading hover. Only active threads get a marker (`isActiveThread`: open, approved, or merged with highlighted changes); a section whose threads are all closed shows nothing, and every thread stays in the Threads panel. The marker shows a status dot and a count; hovering outlines the section; clicking opens a popover (rendered inside the marker's DOM) listing the active threads, the closed ones folded under "N closed", and **New thread on this section**. A click outside or Escape closes it. Highlights of landed changes (inserted text marked, removed text struck through) split at line ends so they never wrap the badge, and a badge on the line of the first change: "Changed by …" (opens the thread) and **Hide changes**. A merged thread's view has **Hide changes in doc** while `ThreadInfo.highlighted` |

Markers are mapped through edits and rebuilt when the index changes or the popover opens or closes (`index.map.observe`, dispatched in a microtask so it never runs inside an editor update).

## IPC

Everything goes through `MantaApi` (`src/shared/ipc.ts`); `main` validates every argument. Thread calls: `createThread` (offset), `listThreads`, `createSubthread`, `listSubthreads`, `getThread`, `setThreadStatus`, `threadProposal`, `threadTranscript`, `approveThread`, `threadLanded`, `dismissThreadChanges`, `sendThreadMessage` (resolves when the turn ends), `cancelThreadTurn`, `answerThreadPermission`, plus `claudeStatus` and `claudeSignIn`. Streamed: `thread:event` with `ThreadEvent` (`turn-start`, `text`, `tool`, `proposal-changed`, `permission`, `permission-resolved`, `error`, `turn-end`).

Types the renderer needs live in `shared/ipc.ts` and are re-exported from core, never the other way round.

## Developing

```sh
npm run dev          # electron-vite dev --watch, own profile (manta-dev): main/preload changes restart it
npm test
npm run typecheck    # with rtk installed, `rtk proxy npx tsc --noEmit -p tsconfig.json` shows real output
```

- **Never use the real vault to test.** Run an isolated instance: build, then `MANTA_USER_DATA=/tmp/<profile> ./node_modules/.bin/electron . --remote-debugging-port=<port>`, with `<profile>/settings.json` set to `{"projects":[{"root":"<realpath>","name":"docs","kind":"docs"}]}` pointing at a repo copy in `/tmp`. Add `MANTA_FAKE_AGENT=1` unless you mean to spend real usage.
- **Smoke run:** `smoke.sh all` (dev-scripts folder above) builds committed HEAD into `/tmp/manta-head`, then runs `threads-e2e`, `subthreads-e2e`, `permissions-e2e` and `changes-e2e`, each against a fresh repo, profile and instance with the fake agent; `smoke.sh <script>` runs one. Output and screenshots land in `/tmp/manta-smoke/<script>/`. Run it after changing anything between `main/` and `core/`.
- **UI e2e scripts** (CDP, in the dev-scripts folder above): `threads-e2e.mjs`, `markers-e2e.mjs`, `subthreads-e2e.mjs`, `permissions-e2e.mjs`, `markdown-e2e.mjs` (rendered replies, links stay out of the app window), `changes-e2e.mjs` (stage, unstage, discard, commit staged, smart commit; also needs `--inspect=9337` to stub the discard dialog in main), `panel-e2e.mjs` (search, New File/Folder, per-context tabs, Back; takes the code repo instead). Each takes `<repo> <shot-prefix>`, expects port 9339 and the fake agent, prints PASS/FAIL per check and writes screenshots. Read the screenshots: DOM checks passed while a merge-view bar rendered bright white.
- **Live scripts** (real Claude Code, real usage, ask first): `live-smoke.mjs` and `live-smoke-o19.mjs` on port 9340, without `MANTA_FAKE_AGENT`. Launch the instance with every `CLAUDE*` and `ANTHROPIC*` variable stripped when running from inside a Claude Code session (in zsh: `env ${=UNSET} ...`, because zsh doesn't word-split `$UNSET`).
- Main-process tests for threads are in `src/core/__tests__/workspaceThreads.test.ts` (real temp git repos with a bare origin and clones); agent options and the fence in `claudeCodeAgent.test.ts`.

### Gotchas

- `@anthropic-ai/claude-agent-sdk` is ESM-only and the main bundle `require`s it; this works because Electron 44 runs Node 24. Check with `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron script.cjs`; `electron -e` launches a window instead of evaluating code.
- In this Chromium, `scrollIntoView()` returns a Promise: an expression-bodied `useEffect(() => el.scrollIntoView())` hands React a non-function cleanup and the whole tree unmounts (`destroy_ is not a function`). Use block bodies.
- `@codemirror/merge` styles its collapsed-lines bar with its own light/dark theme; override it with enough specificity (`.editor.proposal-diff .cm-editor .cm-collapsedLines`).
- SDK `canUseTool` options require `toolUseID` and `requestId` in tests.
- `streamdown` styles itself with Tailwind classes, which Manta doesn't have: style replies through its `data-streamdown` attributes under `.message.assistant`. Links open in the browser because `main` denies new windows and cross-origin navigation (`setWindowOpenHandler`, `will-navigate`), so streamdown's own link-confirm modal is off.
- A killed instance can hold its debugging port briefly: `pkill -f "remote-debugging-port=<port>"` before relaunching.

## Known limits

- An unapproved proposal doesn't travel to another machine; a fresh clone restarts open forks from the doc.
- Records don't travel with git: a fresh clone or a teammate has no threads until `.manta/` gets its own sync (roadmap P7).
- Commits made outside Manta don't refresh records; if they change a section's text, a repo re-finding threads from records may show that thread detached.
- A crash mid-turn loses that turn's assistant messages (the user message and the agent's edits survive).
- A subthread always covers its parent's whole section.
- When an edit replaces a section's last characters (an approved thread rewriting its heading), the anchor's end stays where the old characters were, before the new text, so the anchored range and the thread view's quoted section shrink. Kept on purpose: the margin marker only uses the section's first line, which stays correct.
- Landed-change highlights are local CRDT state, not in the record; threads merged before they existed show their diff in the thread view only.
- Claude Code creates a `.claude/` folder in each thread folder; only the doc file is absorbed.
- The user's own hooks run inside thread turns.
- Once, during a repro, a copied doc lost its recorded highlights between sessions; not reproduced since. The only code path that clears them is **Hide changes**.
