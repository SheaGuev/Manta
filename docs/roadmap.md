# Roadmap

Manta is two things on one app:

- **A shared documentation maintainer.** A docs repo is the source of truth. Docs are living (CRDT-backed markdown, git outward), threads inside them scope ideas with an agent, and docs stay in step with the code they describe.
- **An agentic ADE.** Code repos and their worktrees sit next to the docs. Work happens in worktrees through terminals and agent sessions, linked back to the doc that asked for it.

Think Obsidian (vault, live preview) plus Orca (worktrees, terminals, agents), shared between people like Delta.

This file is the high-level plan. How built features work: [living-docs.md](living-docs.md), [threads.md](threads.md), [terminals.md](terminals.md), [implementation-threads.md](implementation-threads.md), [context-maps.md](context-maps.md). Where Manta is behind on performance and polish: [quality-bar.md](quality-bar.md).

## Features

| Code | Pillar | Feature | Status |
|---|---|---|---|
| P1 | Docs | Living docs | Built |
| P2 | Docs | Threads in docs | Built |
| P3 | ADE | Projects and worktrees | Built |
| P4 | ADE | Terminals per worktree | Built |
| P5 | ADE | Implementation threads | Built |
| P8 | Maintainer | Context maps | Built |
| P10 | ADE | A code editor for developers | Built |
| P12 | ADE | Orca polish: navigation, compare branch, reviews and PRs | Built |
| P11 | Foundation | Orca-level performance and polish | Started |
| P9 | Docs | Doc history without git | Next |
| P6 | Maintainer | Docs that follow the code | Started |
| P7 | Sharing | Shared docs and threads | Later |

Built items come first, then the rest in the order they'll be worked on. Codes stay the same when the order changes, so references elsewhere keep working.

Order: P11's quick wins, P10, P11's G1 and G4, P8 and P12 are done. Next is P9 (Manta's own doc history replaces git for docs), then the rest of P6, then P7. P11's remaining gaps fit around them; G5 comes before split panes.

**Manta's own data.** Threads and context maps live together in the docs repo's `.manta/` folder and are handled the same way: users never commit them; Manta stores and shares them. The plan, in three steps:

1. **Now:** `.manta/` is kept out of git (`.git/info/exclude`) and out of every commit. Threads and maps are local to each machine.
2. **Next:** Manta commits `.manta/` to its own git ref (like git notes) and pushes and fetches it alongside the docs, never on the user's branch. Threads and maps then reach teammates and fresh clones.
3. **Later, with accounts:** `.manta/` moves to a cloud database, which is what P7's live sharing runs on. The docs and their history (P9) move there too.

Once P9's history store exists, step 2 may use it instead of a git ref; decide then.

### P1. Living docs (built)

Every markdown file in the docs repo is backed by a Yjs CRDT. Edits from outside the app (Obsidian, an IDE, a teammate's push) come back in as minimal ops, so anything anchored to unchanged text survives. Commit and fast-forward pull from the app (P9 makes both automatic). Live preview in the editor.

### P2. Threads in docs (built)

Start a thread on a section; the user's own Claude Code proposes an edit in a fork of the doc. Approving merges it and makes one commit with a `Manta-Thread: <id>` trailer, then highlights what changed. Subthreads, section markers in the margin, thread records in `.manta/threads/` (kept out of git; see Manta's own data, above). Threads are never deleted.

### P3. Projects and worktrees (built)

Add code repos as projects; create and remove worktrees on `manta/<name>` branches. Each worktree has a Files and Changes panel, a code editor, a diff against HEAD, search, and its own set of tabs. The Changes tab stages, unstages, discards and commits, like VS Code's source control view.

### P4. Terminals per worktree (built)

Open terminals inside a worktree, so a Claude Code session can run there and implement.

- **Tracked agent terminals (default):** Manta starts Claude Code in the worktree and knows about the session (running, waiting for input, done), like Orca's agent terminals.
- **Plain shells:** an ordinary terminal in the worktree for anything else, including running `claude` by hand.

Terminals run in any context (docs repo or worktree), survive context switches and window reloads, and a Claude tab can resume its conversation after a relaunch. How it works: [terminals.md](terminals.md).

**Deferred follow-ups** (not scheduled; the details are in [terminals.md](terminals.md) under Known limits): the folder-trust prompt shows as `starting`; after Esc a tab stays `working` until Claude's idle reminder; Shift+Enter isn't a newline in Claude's prompt; no output flow control; a terminal whose tab is gone stays in `terminals.json` until its root closes.

### P5. Implementation threads (built)

Start implementation work from a doc section: a tracked session (P4) in a worktree, linked both ways. The session knows the doc section and thread it came from; the doc shows a status chip on the section (branch, PR; in progress or landed). How it works: [implementation-threads.md](implementation-threads.md).

**Deferred follow-ups:** enforce the docs repo being read-only for the session (today a rule in its brief); confirm a resumed session sees an updated brief; a **Mark as landed** action for merges git and `gh` can't see; a doc icon on worktree rows that have an implementation.

### P12. Orca polish: navigation, compare branch, reviews and PRs (built)

Six features from Orca that make working across worktrees and reviewing work smoother, done before P9. In order, each shipped on its own (about two weeks in total). The design, with decisions and open calls: [superpowers/specs/2026-10-26-orca-polish-design.md](superpowers/specs/2026-10-26-orca-polish-design.md).

- **Dismiss map suggestions (built):** an × on hover and right-click **Dismiss**; dismissed folders stay dismissed and can be restored.
- **Back and forward across the app (built):** one history for the window, so back returns to the last tab even in another worktree; arrows in the header, ⌘[ / ⌘] and the mouse buttons.
- **Compare branch picker (built):** the Branch tab's "vs <branch>" becomes a picker, remembered per worktree.
- **Diff comments to agents (built):** a **+** in a diff's margin adds a comment, deleted lines included; send it to any open Claude agent (the same worktree's first), or collect them in the right panel and send a batch. The agent starts working; Manta doesn't switch tabs. These stay in Manta. How it works: [reviews.md](reviews.md).
- **A PR tab (built):** the branch's PR, its CI checks and its comments; send teammates' comments to an agent behind the user's own prompt template (asked once, editable); **Create draft PR**. How it works: [reviews.md](reviews.md#the-pr-tab).
- **PR review (built):** go through the PR's files ticking each viewed, comment on lines as single comments or a review, then **Finish review** (comment, approve, request changes). The PR is the one on a worktree's branch; a list of PRs awaiting review, without needing a worktree, comes later. How it works: [reviews.md](reviews.md#pr-review).

### P11. Orca-level performance and polish (started)

Manta takes the best quality-of-life ideas from Orca and adds docs that stay up to date. It has to match Orca's quality on the basics: performance, state management, caching and dev experience. [quality-bar.md](quality-bar.md) compares the two codebases and lists the gaps (G1 to G9), quick wins (A1 to A10) and missing features, with fixes and estimates.

- **First, about a day:** daily-drive a built app instead of the dev server, with dev on its own profile (G2), plus the quick wins. Examples: stop the blocking shell lookup in main, filter `node_modules` out of the watcher, the WebGL terminal renderer, an app menu so ⌘W closes a tab.
- **Then the main slowness:** a file change, including Manta's own doc saves, makes every panel refetch through about 9 git spawns (G1); switching context rebuilds every terminal and editor (G4).
- **Before split panes:** move app state out of `App.tsx` into a store with selectors (G5), since splits multiply re-renders.
- **Later:**
  - terminals in their own process, with flow control, surviving restarts (G3)
  - faster startup (G6)
  - virtualised lists (G7)
  - session state in main (G8)
  - lint, CI, error boundaries and packaging (G9)
- **Quality-of-life features:** tab drag, pin and reopen; split terminals; clickable terminal links that open files and URLs inside Manta; a command palette and ⌘P; PR and checks status on worktree rows; notifications. Each is listed with its effort in the doc.

### P10. A code editor for developers (built)

**Built:** all four stages; how it works is in [code-editor.md](code-editor.md). TypeScript runs on TypeScript 7's own language server instead of `typescript-language-server`. Lint servers (ESLint, Biome, Ruff) run beside each file's primary server. Rename and references reach files without a tab. Still open: quick fixes from lint servers, configs in monorepo subfolders, and undoing a format with Cmd+Z.

The worktree code editor was a bare CodeMirror: line numbers, syntax highlighting, the default keys and Tab to indent. The goal is an editor developers would pick over VS Code or Cursor for this work, covering everything a typical web and mobile stack uses (TypeScript, JavaScript, GraphQL, YAML, JSON, Swift, Kotlin, Terraform, Protobuf) plus Python. It stays CodeMirror, so docs, threads and diffs keep working in it. Four stages, each shipped on its own (about 3 weeks in total):

- **S1. CodeMirror basics and navigation (1 day):** find and replace in the file (Cmd+F), go to line, folding, multiple cursors, matching and auto-closing brackets, indent on input, word completion, Cmd+Shift+F to the panel's search across files, and Cmd+P to find and open a file by a fuzzy match on its name (`name:42` opens at a line).
- **S2. Language servers (4½ days):** one per worktree and language, run in main like terminals, talking to `@codemirror/lsp-client` in the renderer. TypeScript and JavaScript first, bundled: Cmd-click to definition (across files and into `node_modules`), hover types, errors as you type, completions, rename, references.
- **S3. Format on save (1½ days):** Cmd+S formats with the project's own Prettier, Biome or Ruff (else the language server's formatter), applied as minimal edits so thread anchors survive.
- **S4. Plugins and a plugin browser (9 days):** declarative plugins (no plugin code runs in Manta) that add language servers, linters, formatters and themes. Installs come from the Mason registry; a one-click core set covers Python, GraphQL, YAML, JSON, ESLint, Biome, Terraform, Swift, Kotlin, Protobuf and Shell; VS Code themes come from Open VSX.

Later, editor habits not in the plan: an **Open in editor** action (VS Code or Cursor at the same line) and replace across files.

The plan, with findings, decisions (D1 to D10), steps and risks, lives outside the repo.

### P9. Doc history without git (next)

Docs stop being version-controlled in git. Manta keeps their history itself, like Delta: nobody commits, every change is recorded as it lands, and changes are grouped and tagged by what made them so a whole batch can be reverted at once. It builds on the Yjs update log every doc already has ([living-docs.md](living-docs.md)).

- **Change sets, tagged:** every change belongs to a change set named for its source: a thread approved, a proposal accepted, an agent session's edits, a map launch's wrap-up, or a stretch of hand edits (closed after a pause in typing). Tags carry the source's ids (thread, session, ticket, map) and the author, so history can be filtered by any of them.
- **Revert in batches:** pick one change set or many (everything one agent session did, one ticket, one afternoon) and revert them together. A revert is itself a change set, so it can be undone. Reverts apply through the CRDT, so later edits to other text stay.
- **History view:** per doc and per section, change sets in order with their diff, tags and author. This is P6's section history for docs.
- **A simpler surface:** the docs context shows Files and Threads only. Changes, Branch, commit and pull stay for code worktrees.
- **Sharing moves to P7:** teammates get changes through the same store (then the cloud database), not git push and pull.

**Open questions:**

- Does the docs folder stay a git repo at all? Options: no git; or a one-way export to git as a mirror, for Obsidian, GitHub and code sessions that read the files.
- Where the store lives: the Yjs log is under `.git/manta/` today, which can't stay if git goes.
- Growth: snapshots and compaction of the log, and how far back a revert can reach.
- Reverting a change set whose text a later change set edited: skip, merge, or ask.
- An existing docs repo's git history: import one change set per commit, or start from its current state.

### P8. Context maps (built)

A context map is a workspace that holds the context for one thing (a feature, an area of the code, a project), generated by an agent and kept up to date. It is how Manta does context engineering for agents: instead of each doc knowing only its own threads, the map gathers everything relevant in one place and hands it to the agents working on it.

- **Collects the docs:** the docs, sections and threads about the thing, from across the docs repo, with a short generated overview (what it's for, how it works, its invariants).
- **Maps it to code:** entry points and key files in each code repo (`repo:path`), plus the worktrees, sessions and PRs working on it.
- **Feeds agents:** a Claude session or thread started from a map gets the map as context, so iterating starts with everything relevant instead of a cold search. The way in already exists: a map can reach a session as an implementation's brief and added folders do (P5), and its sessions can propose doc changes back (P6).
- **Stays current:** an agent refreshes the map when its docs or linked code change. Map edits are proposed and approved like any doc edit.
- **Holds the design stages:** the feature-map stages (product → architecture → program → slices) live inside the map as files it links. Builds on a common way of tracking features in docs (index, one file per repo, overview, screenshots, tickets).

**Where they live:** `.manta/maps/`, next to threads and handled the same way (see Manta's own data, above): local for now, shareable once `.manta/` has its own ref.

**Surface:** the left sidebar's docs section becomes the list of context maps, with **New context map** and maps Manta suggests (from clusters of docs and threads it finds). The docs file tree has already moved out of the sidebar (the docs repo is a context row; **Change docs repo…** is in the Projects header); its files are in the right panel, as for worktrees. Opening a map opens it like a workspace.

**As built, v2** ([context-maps.md](context-maps.md)): a map is the home for one feature: its docs tied to milestones and sections, a tracker of milestones and tickets, and one-click launches (a worktree and branch per ticket or per milestone, a tracked Claude session with a scoped brief and the map tools). Statuses follow launches, agent reports, pull requests and landing without approval; agents journal and wrap up, suggesting docs, tickets and doc changes into Needs review; a sweep (small model, on by default per map) wraps up sessions that didn't. Ask the map answers questions and proposes plans (Break down). v1's `map.md`, staleness and Refresh, stages and folder suggestions are gone; v1 maps convert on first open.

**Then, for agent-driven work end to end:** tickets carry acceptance criteria and dependencies (Break down fills both in, and each ticket's code project); tickets that can run at once start in parallel, each in its own worktree. Briefs end with a Finishing step (the project's checks from the map's settings, commits with the trailer, a draft pull request) and name other sessions sharing a worktree and earlier wrap-ups in the milestone. Wrap-ups say whether the work is finished and judge each criterion; finished work without a pull request gets **Open PR**. Pull requests' checks and review are followed (in the background too, every 5 minutes, `gh` only), and failing checks or review comments go back to the launch's session in one click. A session's next prompt is told what moved in its scope (ticket edited, doc changed, sibling work landed) and unblocks its ticket. Agents propose plan changes (reword, split, reorder, drop), approved one by one. A landing pass checks the docs against what landed. Journals live with the map in `.manta/`. In a map's context the Files tab shows the map's docs. Implementing a map doc's section defaults to a ticket on the map.

**Deferred follow-ups:** Linear as the tracker's source; sharing maps with `.manta/`'s own ref; opening a ticket's doc section at its heading.

### P6. Docs that follow the code (started)

Keep docs right as the code changes.

**Built:**

- **Doc proposals from implementation sessions:** a session (P5) calls Manta's `propose_doc_change` tool for each doc change it finds. Each one becomes a thread on its section with the edit proposed, its reason as the first message, and a link back to the implementation; approve, discard or discuss it like any other thread ([implementation-threads.md](implementation-threads.md)). This is the **external thread**, raised while the work happens. Not yet tried with a real session.
- **Revise and withdraw proposals:** `propose_doc_change` returns the thread's id. With it the session can change an open proposal (`revise_doc_change`) or take it back (`withdraw_doc_change`), which discards it with the reason; threads are never deleted (P2). Only the implementation that proposed it can do either.
- **The session knows its doc:** an implementation session gets the section, the thread it came from and read access to the docs repo (P5).
- **PRs on the section:** an implementation's chip shows its branch's pull request until it lands (P5).

**Next:**

- **Reference any doc or thread from a Claude session**, not only the one it started from. P8 does this for a whole feature at once.
- **What changed since the session last looked:** a linked session remembers the doc version it last read. When the doc has moved on, the Claude Code hooks Manta already installs (`SessionStart`, `UserPromptSubmit`) add a one-line note to the next prompt, such as "Since you last read `auth.md`: 3 threads approved, 1 proposal open". A Manta tool (next to `propose_doc_change`) then lets the session re-read the doc, list the threads merged since, read each one's conversation and diff, and see which session or implementation it came from. Reading marks the doc as seen. This keeps sessions current without re-sending whole docs, which helps context management later (P8).
- **Doc updates after landing:** when merged work changed what a doc describes and no proposal covered it, Claude reviews the landed diff and raises external threads.
- **Section history:** a section lists every implementation and PR that changed its code, after their chips are hidden.
- **Living links** from doc text to code (symbol anchors plus a hash of the symbol's body), flagging a doc as stale when the linked code changes meaningfully.

### P7. Shared docs and threads (later)

Sync between people, like Delta, including what lives in `.manta/` (threads, context maps), which Manta stores and syncs itself rather than leaving to users' commits: its own git ref first, then a cloud database once there are accounts (see Manta's own data, above). Today git carries only the markdown; thread records, open proposals, landed-change highlights and CRDT history stay on one machine. Not designed yet.
