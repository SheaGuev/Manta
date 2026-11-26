# Implementation threads

How implementation threads work in Manta, for anyone changing them. Built for roadmap item P5 ([roadmap.md](roadmap.md)). The plan, decisions (D49 to D57) and spike results live outside the repo.

## What one is

An implementation thread starts implementation work from a doc section: a tracked Claude Code session ([terminals.md](terminals.md)) in a worktree of a code project, linked both ways.

- **In the doc:** it is a thread ([threads.md](threads.md)) on the section, so it has the same anchor, record, re-finding and margin marker. It has no fork and no transcript: the conversation is in the terminal. Its marker is square and reads `implementing · <branch> · PR #n`, then `landed`.
- **In the worktree:** a Claude tab with an **Implementing <doc>** bar that opens the doc.

| Status | Meaning |
|---|---|
| `open` | In progress |
| `merged` | Landed. The chip shows **Landed** until hidden |
| `discarded` | Abandoned. The session and worktree are left as they are |

Invariant: **the session never changes the doc.** It can read the docs repo (`--add-dir`), and its brief tells it the repo is read-only. That is a rule, not a fence (plan D56, R40). Doc changes go back through Manta (roadmap P6).

## Data model

```
ThreadEntry / ThreadRecord (.manta/threads/<id>.json)
 └─ implementation: { source, project, worktree, branch, session, terminal, hidden, base, pr }

TerminalRecord (<userData>/terminals.json)
 ├─ link:    { docsRoot, doc, thread }
 ├─ brief:   <userData>/implementations/<thread id>.md
 └─ addDirs: [docs repo]
```

| Field | What it's for |
|---|---|
| `source` | The doc thread it was started from. Its conversation goes into the brief. Not `parent`, which means a fork-based subthread |
| `worktree` | As git lists it, so it matches the sidebar's worktree rows. The terminal runs in its real path |
| `session` | Picked before the terminal starts, so a closed tab can be reopened with `--resume` |
| `terminal` | The terminal on this machine. A stale id just means "no tab open" |
| `base` | The branch's commit when work started. Null when the work runs on the default branch itself |
| `pr` | Last pull request seen. Kept when `gh` can't be asked |

Records written before P5 have no `implementation` and parse as doc threads. Terminal records without a link, brief or extra folders parse with none.

## Flows

### Start

`Implementations.start(request)` (`src/core/implementations.ts`), from the **Implement** dialog:

1. It refuses before creating anything when there is no prompt or Claude Code isn't installed.
2. It creates the worktree (`manta/<slug>`), or uses an existing worktree of the project.
3. It records `base` unless the worktree is on the default branch, then calls `threads.createImplementation` on the section around the offset, or on the source thread's section.
4. It starts the Claude terminal. The first prompt goes first in the argument list, then the user's extra arguments, `--settings`, `--session-id`, `--append-system-prompt-file <brief>` and `--add-dir <docs repo>`. The prompt has to come first because `--add-dir` takes a variable number of arguments and would swallow a prompt placed after it. A prompt starting with `-` gets a leading space so it isn't read as an option.
5. If the terminal fails to start, the thread is set to `discarded` (threads are never deleted) and the new worktree is removed.

Entry points: the margin marker's popover (**▸ Implement this section…**), **▸ implement** on hovering a heading, **Implement this section…** in the Threads panel, and **Implement** in a doc thread's header.

### The brief

`implementationBrief` (`core/threads/implementationBrief.ts`) is pure. It contains:
- the doc path and docs repo,
- the read-only rule,
- the trailer to end commits with (`Manta-Thread: <id>`),
- how to change the doc: through proposals only, at the doc's level of detail (below),
- the section, fenced with a fence longer than any inside it,
- the source thread's user and agent messages.

`TerminalManager` calls `refreshBrief` before every start and Resume, so a resumed session gets the section as it is now. Whether Claude Code re-reads a changed `--append-system-prompt-file` on `--resume` is unverified (R39).

### Reopening the session

Opening an implementation thread anywhere (marker, panel) calls `Implementations.openSession`:
- If its terminal is still open, it returns that terminal.
- Otherwise it starts a new terminal in the worktree with `--resume <session>` and links it to the thread.

Either way the renderer switches to the worktree and focuses the tab.

### Landed and pull requests

`Implementations.check` runs when:
- the doc opens,
- the window regains focus,
- or one of the doc's linked sessions goes idle or exits (`useImplementationChecks`).

It never runs on a timer and never fetches.

| Landed when | Why |
|---|---|
| A commit with the `Manta-Thread: <id>` trailer is on the default branch, local or `origin/` | Survives squash merges that keep the message |
| The branch tip has moved past `base` and is an ancestor of the default branch | Works when the trailer is missing. `base` stops a fresh branch, whose tip is already on main, from counting |
| `gh` reports its pull request as merged | Covers a merge on GitHub that hasn't been fetched |

The default branch is `origin/HEAD`, or the project's checked-out branch when that isn't set. `ghPullRequests` (`core/repo/github.ts`) runs the user's own `gh pr list --head <branch> --state all` and caches answers for 60 s. When `gh` is missing or fails it returns null, and the last PR seen is kept. Landing sets the status to `merged`, which reaches the editor through the doc's CRDT like any thread change.

### Doc proposals from the session

An implementation session has three Manta tools: `propose_doc_change({ doc, find, replace, title, why })`, and `revise_doc_change` and `withdraw_doc_change` for taking a proposal back or changing it (below). Its brief tells it to call `propose_doc_change` rather than only listing changes, and keeps proposals at the doc's level: something the doc gets wrong, missing architecture, or a decision or fix the doc didn't foresee. Each proposal is a decision and its reason, never code-level detail, and related points about one section go into one proposal. The tool's description says the same. They're the first slices of roadmap P6, planned outside the repo.

1. **Transport.** `HookServer` also serves `POST /mcp/<terminal id>`, using the per-run token as a Bearer header. `mcpEndpoint.ts` answers it: JSON-RPC over Streamable HTTP, with JSON responses only; a `GET` for an event stream gets 405. Linked sessions start with `--mcp-config` (rebuilt on every start, because the port and token change each run) and with `--allowedTools` for each tool (`mcp__manta__propose_doc_change` and so on). The tools need no permission because nothing reaches the doc until the user approves. Other terminals get no tools.
2. **What a call does.** `Implementations.proposeDocChange` finds the session's link, then `threads.propose` checks the change:
   - The doc must exist.
   - `find` must appear exactly once.
   - `replace` must differ from `find`.

   A refusal goes back to the agent as a tool error it can act on. Otherwise it creates an ordinary doc thread on the section containing `find`, with `proposedBy: { doc, thread }`, the edit already in its fork, and a transcript of a status line ("Proposed by the implementation “X” (branch)") plus the reason as an agent message. The answer gives the thread's id.
3. **Changing its mind.** With that id, the session can revise or withdraw the proposal while it is open. Both find the doc from the thread record, and refuse a thread whose `proposedBy` isn't the session's own link or that is no longer open.
   - `revise_doc_change({ thread, find, replace, why })` edits the proposal's fork (`threads.revise`). `find` is quoted from the proposed version, not the doc, so edits the user or the thread agent made there survive.
   - `withdraw_doc_change({ thread, why })` sets it to `discarded` (`threads.withdraw`). Threads are never deleted, so it stays under Discarded with its diff.

   Each adds a status line ("Revised by…", "Withdrawn by…") and the reason to the transcript.
4. **Review.** The status bar announces it (`implementation:doc-proposed`). The thread view links back to the implementation. Approve, Discard, subthreads and chatting with the thread agent all work as for any thread.

A session started before a tool existed doesn't have it. It gets it on its next start or Resume, since `--mcp-config` and `--allowedTools` are rebuilt every time.

## IPC

- `startImplementation(request)` returns `ImplementationStart`; refusals come back as `ok: false`.
- `openImplementationSession(docsRoot, doc, id, cols, rows)` returns a `TerminalInfo`.
- `checkImplementation(docsRoot, doc, id)` returns a `ThreadInfo`.
- `onDocProposed(docsRoot, thread)` is streamed when a session proposes a doc change.
- Abandoning and hiding reuse `setThreadStatus` and `dismissThreadChanges`.

## Developing

- **Tests:**
  - `src/core/__tests__/implementations.test.ts`: real temp repos and the scripted `claude`. Covers start, rollback, reopen and resume, and the landed and PR checks.
  - Thread entry and record round-trips are in `core/threads/__tests__/`; the brief, the session options and `gh` parsing each have their own tests.
- **Fake claude:** `scripts/fake-claude.mjs` takes a first argument that isn't an option as the first prompt. It prints the brief's marker line and the `--add-dir` folders. `propose <doc>|<find>|<replace>|<why>` calls `propose_doc_change` through `--mcp-config`, the way Claude Code would; `revise <thread>|<find>|<replace>|<why>` and `withdraw <thread>|<why>` call the other two, with `last` for the last proposal's id.
- **UI e2e:** `implementation-e2e.mjs` in the dev-scripts folder runs in two phases, `start` then `relaunch` on the same profile, against a docs project and a code project.

## Known limits

- The docs repo being read-only is a rule in the brief, not enforced. The tool gives the session a sanctioned way to change docs, which should make editing them directly less likely.
- The link stores absolute local paths (project, worktree) and a machine-local terminal id. A teammate gets the branch and section once `.manta/` is shared (P7), but has to open the work in their own worktree.
- Landed detection doesn't fetch. A merge on a remote shows only through `gh`, or after a fetch.
- A squash merge whose message drops the trailer, on a repo `gh` can't see, is never detected as landed. **Abandon** still closes the chip.
- Whether a resumed session sees an updated brief depends on Claude Code re-reading `--append-system-prompt-file` (R39, unverified).
