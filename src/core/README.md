# core

Everything that touches the working tree, git, the CRDTs and the agent. No Electron imports; `main/` wraps it, and its tests drive it directly against real temp git repos.

| Entry | What it does |
|---|---|
| `workspace.ts` | `Workspace`: one open docs repo. Composes everything below: files (create, delete), search, docs, threads, stage / unstage / discard, commit, pull. Owns the serial queue every disk and git operation runs on. |
| `workspaceThreads.ts` | `WorkspaceThreads` (`workspace.threads`): create, subthreads, propose (and revise or withdraw a proposal), approve, status, and adopting and exporting thread records. Reaches the workspace only through `WorkspaceAccess` (the serial queue, docs, git, absorb, write now). |
| `workspaceMaps.ts` | `WorkspaceMaps` (`workspace.maps`): context maps in the docs repo. Their settings, docs and sections, the tracker (hand edits, statuses set by events), launches and journals as stored, suggestions waiting in Needs review (accepting adds a doc, creates a doc worth writing, or adds proposed milestones or tickets), the open doc changes its agents proposed, and Ask the map's agent through its own `ThreadTurns` (it reads the map's outline and never edits anything). Converts v1 maps the first time they're listed. Reaches the workspace only through `WorkspaceAccess`. |
| `threadTurns.ts` | `ThreadTurns`: runs one agent turn per thread (the event loop off the serial queue), its permission requests, cancel. Reaches the thread's fork and record only through `TurnSteps`, which `WorkspaceThreads` provides. `ThreadOptions` (agent, thread folders, events). |
| `implementations.ts` | `Implementations`: implementation threads end to end. Starts one (worktree, thread, brief, Claude session, undone in reverse when a step fails), reopens its session, writes its brief before each start, checks whether it has landed and what its pull request is, and handles its session's `propose_doc_change`, `revise_doc_change` and `withdraw_doc_change` calls (`proposeDocChangeTool` and the other two). Composes the project registry, the docs workspace's threads and the terminal manager. |
| `mapLaunches.ts` | `MapLaunches`: work launched from a map's tracker. Creates the worktree and branch (or reuses the milestone's, or the ticket's own), starts a tracked Claude session with the scope's brief (rebuilt before every start, with the start's note), previews a ticket's brief, workspace and permissions for the brief page without creating anything (`previewBrief`), moves statuses as the work moves (launch, pull request, landing), follows each open pull request's health (checks, review) and checks every map in the background (`checkAll`), opens a draft pull request for finished work and sends failing checks, the PR review or the user's requested changes back to the session (`openPullRequest`, `sendFeedback`, `requestChanges`), marks a ticket done after the user's review with the doc updates they included (`markDone`), sends the outcome of a decision a session raised to that session once the user decides it (`editTracker`), adds what moved in a session's scope to its next prompt and unblocks its tickets (`promptContext`), serves the map tools to sessions, the sweep, Ask the map and coordinators (`toolsFor`), keeps the board (`board`, from sessions' `report_progress`) and runs a batch's coordinator (`coordinate`: a Claude session with the board as its only view, woken with a prompt when something on it needs the user), and runs the sweep when a session ends without wrapping up and the landing pass when its work lands. Composes the project registry, the docs workspace's maps and the terminal manager. |
| `maps/` | Context maps: the data model and its rules, the store, briefs and prompts, the map tools' definitions, IPC validators, and the v1 migration. |
| `review/` | Review comments on diff lines: their store per worktree and the message an agent gets. |
| `docs/` | Living docs: one markdown file plus its CRDT, minimal text → CRDT ops, CRDT persistence. |
| `threads/` | Thread index inside each doc's CRDT, thread records (local, kept out of git), thread forks. |
| `agent/` | The thread agent interface, Claude Code behind it, Claude Code install/login status. |
| `repo/` | Git (shelled out) and the project registry: docs repo, code repos, worktrees. |
| `terminal/` | Terminals in a context root: PTYs with a headless screen copy, Claude Code session state from hooks, their environment and records. |
| `plugins/` | Plugins: language servers, linters and formatters from Mason's registry with Manta's launch recipes, and editor themes from Open VSX. |
| `format/` | The project's own formatter for a file (Prettier, Biome, Ruff), run on stdin for Cmd+S. |
| `lsp/` | Language servers for the code editor: one process per root and server, JSON-RPC over stdio. |

## Who may import what

```
workspace.ts ──▶ workspaceThreads.ts, workspaceMaps.ts, review/reviewComments.ts, docs/, repo/git.ts, threads/threadRecords.ts (MANTA_DIR)
workspaceMaps.ts ──▶ threadTurns.ts, maps/, threads/ (records)
workspaceThreads.ts ──▶ threadTurns.ts, docs/, threads/, repo/git.ts (type)
threadTurns.ts ──▶ agent/threadAgent.ts (types), threads/threads.ts
repo/projects.ts ──▶ workspace.ts, repo/git.ts, agent/threadAgent.ts
implementations.ts ──▶ repo/projects.ts, repo/git.ts, repo/landing.ts, repo/github.ts (type), terminal/terminals.ts (types)
mapLaunches.ts ──▶ maps/, ../shared/mapBoard.ts, implementations.ts (doc tools), review/pullRequestMessage.ts, repo/git.ts, repo/github.ts (types), repo/landing.ts, repo/projects.ts (`worktreeSlug`), terminal/ (types, `claudeArgs.ts`)
threads/threadForks.ts ──▶ docs/
docs/livingDoc.ts ──▶ repo/git.ts (type)
review/ ──▶ threads/implementationBrief.ts (fenced), terminal/terminals.ts (types)
terminal/ ──▶ nothing else in core
lsp/ ──▶ nothing else in core
format/ ──▶ terminal/terminalEnv.ts (findOnPath)
plugins/ ──▶ lsp/serverCatalog.ts (types), terminal/terminalEnv.ts (findOnPath)
everything ──▶ ../shared/ipc.ts
```

`docs/` knows nothing about threads: the thread index lives in the doc's `Y.Doc`, and `WorkspaceThreads` reads it with `new ThreadIndex(doc.ydoc)`.

## Where to look

- Changing how text becomes CRDT ops, persistence, outside edits, pulls: `docs/`, and [docs/living-docs.md](../../docs/living-docs.md).
- Changing threads, forks, approve: `workspaceThreads.ts`, `threads/`. Agent turns and permissions: `threadTurns.ts`; the agent itself and its write fence: `agent/`. Background: [docs/threads.md](../../docs/threads.md).
- Conventions (serial queue, atomic writes, `OpResult`, transaction origins): [docs/patterns.md](../../docs/patterns.md).

## Tests

`__tests__/workspace.test.ts` (living docs end to end: edits, outside edits, commit, pull, reopen) and `__tests__/workspaceThreads.test.ts` (threads end to end through `workspace.threads`: create, agent turns, approve, subthreads) run against a bare `origin` plus clones in temp dirs. `__tests__/implementations.test.ts` starts implementation threads against real temp repos and the scripted `claude`. `__tests__/workspaceMaps.test.ts` runs context maps through `workspace.maps` (tracker and docs edits, suggestions, proposals, Ask the map, migrating a v1 map, remove); `__tests__/mapLaunches.test.ts` launches work from a map with the scripted `claude` (worktrees, briefs, map tools, statuses from pull requests and landing, the sweep). No git mocks.
