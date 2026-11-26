# Context maps

How context maps work in Manta, for anyone changing them. Built for roadmap item P8 ([roadmap.md](roadmap.md)), revamped as v2; the v2 design lives outside the repo.

## What one is

A map is the user's home for working on one feature or project:

- **The context:** its docs (PRDs, RFCs, notes), each tied to any number of milestones and optionally a user-named section.
- **The work:** a tracker of milestones in order, each with optional tickets that carry acceptance criteria and what they wait for. Work is launched from it in one click, tickets that can run at once in parallel; statuses follow the work.
- **Kept current by agents:** launched sessions get a scoped brief and map tools, keep a journal, and wrap up by reporting status, judging the acceptance criteria and suggesting changes (docs, tickets, changes to the plan). A sweep wraps up for sessions that didn't, and a landing pass checks the docs once work lands.
- **Carried to the merge:** finished work gets a draft pull request (opened by the agent, or by Manta in one click); failing checks and review comments go back to the launch's session; a ticket is in review while its PR is open and done once merged and verified with the user; it can span several pull requests.

Opening a map opens its own set of tabs, like a worktree. The map itself is one tab, first and never closed, with its own navigation (Overview, Milestones, Docs, Decisions, Activity, Ask the map); a ticket opens as a page inside it. Sessions launched from a map open in their launch's worktree context, not the map's: the map plans and tracks, the worktree is where the work happens (its session's tab links back to the map).

**Invariants:**

- Status changes never wait for approval. Docs and agent-proposed plans never change without it: doc changes are always doc threads (the user reviews the diff), plans and tickets are suggestions in Needs review, or, on a map that asks first, applied once the user accepted them in the session.
- A session's brief never quotes the whole map: its scope, paths, and tools to query the rest.
- The only agent runs Manta starts on its own are the sweep and the landing pass (small model, one turn, skipped when not needed, off per map with the sweep). A batch's coordinator is started only by the user (accepting the offer); Manta then prompts it when something on the board needs the user, never on a timer. Nothing refreshes in a loop; the background check of pull requests asks `gh`, never an agent.

## Data model

```
.manta/maps/<id>/                 docs repo, out of git; shared later with .manta/
 ├─ map.json                        version 2: title, description, key, stage, projects (by name), launchMode, sweep, confirmProposals (ask | queue),
 │                                  pinned, checks [{ project, commands }], docs [{ path, milestones, section, roles, link? }], sections [{ id, title }]
 ├─ tracker.json                    milestones [{ id ms_…, title, description, doneWhen [{ text, done }], landed, manual,
 │                                    tickets [{ id tk_…, number, title, description, acceptance [..], constraints [..], after [ticket ids],
 │                                               docs [{path, heading}], project, status, blocked }] }],
 │                                  decisions [{ id dc_…, number, title, question, status, outcome, options [{ title, detail, recommended }], chosen, input { label, value }, blocks [ticket ids], docs [{ path, heading }], from, createdAt, decidedAt }],
 │                                  nextTicket, nextDecision
 ├─ journals/<launch>.md            append-only, one line per entry (moved here from .git/manta on first list)
 ├─ activity.jsonl                  append-only activity log, one event per line: { id ev_…, at, kind, title, detail, ticket, milestone, launch, decision, suggestion, doc, thread }
 └─ map.v1.md, product.md …         left by the v1 migration, unread

.git/manta/maps/<id>/             this machine only
 ├─ state.json                      Ask the map's session and conversation; visitedAt, lastVisitedAt, seenAt (Since your last visit, Mark all as seen)
 ├─ launches.json                   [{ id l_…, scope, project, worktree, branch, base, batch, sessions [{ terminal, session, ticket, startedAt, note?,
 │                                               progress { phase, summary, needs { kind, ask }, next, at } }],
 │                                     pr, health { checks, failing, review, unresolved }, landed, readyAt,
 │                                     wrapUp { summary, wentToPlan, finished, criteria [{ ticket, index, met, evidence, source }],
 │                                              checks [{ command, passed }], unverified, decisions, risks, at, sweep },
 │                                     wrappedUpAt, sweptAt, landingSweptAt }]
 ├─ batches.json                    [{ id b_…, createdAt, coordinator { terminal, session, startedAt }, declined }]
 └─ suggestions.json                Needs review: add-doc, write-doc, plan, ticket, plan-change (each with who raised it)

<userData>/maps/<id>/             Ask the map's working folder: map.md, the outline it reads
<userData>/map-briefs/<launch>-<session>.md     a session's brief
<userData>/map-briefs/coordinator-<batch>-<session>.md   a coordinator's brief
<userData>/map-agents/<id>/<launch>/            the sweep's working folder
TerminalRecord.map: { docsRoot, map, launch, ticket, coordinator? }
```

Ids are stable random strings, so a later sync with an outside tracker (Linear) can map them. Nothing in `.manta/` is machine-specific: projects are names, launches (with paths) are local.

**Keys and numbers.** Tickets show as `<key>-<number>` (`OMN-12`): the map's `key`, else the first letters of its title (`mapKey`), and a number per ticket from `nextTicket`, never reused. Tickets and decisions stored before numbers existed get the next ones in plan order when read (`parseTracker`), kept once the tracker is next written. Milestones show as `M1`… by their place, so their titles carry no number: `milestoneTitle` drops a leading `M8 –` wherever a title comes in (hand edits, `propose_milestones`, plan changes) and when a stored tracker is read; decisions show as `006`.

**Statuses.** Tickets: `todo`, `in-progress` (a launch covering it started, or the agent reported it), `blocked` (reported, with a reason), `in-review` (a pull request of its own is open), `done`. Completion is per ticket, not per pull request: a ticket can take several launches and PRs, and merging one changes no ticket's status. A finished wrap-up only marks the launch ready for a PR (`readyAt`). The agent reports `done` once the work is merged and it has verified the result with the user (AskUserQuestion; with `confirmProposals: queue` it leaves `done` to the user): for a ticket on its own branch, `set_ticket_status done` looks up the pull requests first and refuses while one is open (still in review) or while the branch is neither merged nor in a PR (marking it ready for one). Tickets on a shared branch (milestone or group launch) are done when the agent says so. The user can set any status by hand. Starting new work on a ticket in review or done reopens it (in progress). A milestone (`milestoneStatus`) is done when every ticket is done; one with no tickets only when marked done by hand. A hand-set status sticks until the next real event; a milestone's is kept in `manual` and cleared by the next event. The **current milestone** is the pinned one, else the first not done. Stored `accepted` (an earlier name) reads as `done`.

On screen, a ticket shows a work status and, separately, what its agent is doing (`renderer/src/lib/mapStatus.ts`): a ticket to do is **Ready**, or **Blocked** with "Depends on OMN-81" or "Decision 006 required"; its agent is not started, working, needs your answer, paused or finished.

**Definition of done.** A milestone's `doneWhen` items are ticked by the user (`done`); they inform, they don't set the milestone's status. Agents propose and rewrite them as plain text (break down, `propose_plan_change`); a rewrite keeps the tick on any item whose text is unchanged. Items stored as plain strings, before ticks existed, read as unticked. Briefs list them as `- [x]` / `- [ ]`.

**Stage.** `stage` set by hand, else worked out (`mapStage`): planning until work starts, building, validating once every ticket is in review or done, shipped once all are done.

**Dependencies and decisions.** A ticket's `after` lists tickets it waits for; it is **ready** when it's to do, all of them are done, and no open decision blocks it (`readyTickets`, `waitingOn`, `openDecisions`). A decision is a question the work waits on (`open`), then what was chosen (`decided`, with its `outcome`), and later perhaps `superseded`; only an open one blocks the tickets in `blocks`. It can carry `options` (one may be `recommended`) and an `input` the user must fill in before it can be decided ("Production domain"); deciding by choosing an option (`chosen`) writes the outcome from it when none is typed (`applyTrackerEdit`). `docs` are the sections it comes from or changes; a tracker stored with a single `doc` reads as a list of one. The user adds them by hand, or an agent raises one with `propose_decision` (`from` says who): it goes on the map open at once, since deciding it is the review (`MapLaunches.raiseDecision`; an open one with the same title isn't raised twice). A session the user already decided it with passes the `outcome` and `confirmed_with_user` on a map that asks first, and it's recorded decided; elsewhere the outcome is left out. When the user decides one a session raised, the outcome is typed into that session if it's still running (`MapLaunches.editTracker`, journalled), preferring the session on a ticket it blocks. Briefs list a ticket's open decisions, and the outline lists them all. Edits that would make tickets wait on each other are refused; removing a ticket drops it from others' `after` and from decisions' `blocks`. Break down names dependencies by title within its plan, resolved to ids on approval.

**A launch's outcome.** `readyAt` is set when its agent says the work is finished (`wrap_up` with `finished`, or `done` on a ticket on its own branch) and it has no pull request yet. The wrap-up carries what the user reviews from: each criterion judged with its evidence and where it is (`source`), the checks run, what wasn't verified, decisions made and risks. `health` is what its open pull request needs, from `gh` (`pullRequestHealth`: failing checks by name, each reviewer's latest verdict, unresolved threads). `wrapUp` is the last wrap-up; the landing pass never replaces a session's.

## Flows

### Creating and migrating

`WorkspaceMaps.create` writes `map.json` and an empty tracker. The first `list` or `get` converts v1 maps on the serial queue: title and about become title and description, the Docs list becomes docs on no milestone, `map.md` is renamed `map.v1.md`; threads, code and stage files are dropped from the model (stage files stay on disk).

### Launching (`MapLaunches.launch`)

**Start** on a ticket (from any page) opens its **brief page**; **Review N briefs** on Milestones (and **Start N** in Up next) walks several briefs and starts them together. **Start milestone**, or **Launch** on several tickets picked with **Select tickets**, opens a small popover with the map's default worktree mode (per ticket or per milestone; for ticked tickets, a worktree and session each or one for all) and, when ambiguous, the code project; Enter starts it. One launch switches to its worktree; several started at once open there without switching.

- Per milestone, a ticket's session runs in the milestone's launch (created on first use) focused on the ticket (`session.ticket`). Per ticket, it gets its own launch. A launch is reused while it hasn't landed and its worktree exists; groups always get a new one.
- The worktree is `manta/<slug of the scope title>` (numbered when taken); `base` is its HEAD. It's removed again if the session fails to start.
- The session is a tracked Claude terminal: first prompt "Work on “X”, as your brief describes", the docs repo and the map's other projects as added folders, its brief rebuilt before every start and Resume (`refreshBrief`, which also stamps `startedAt`).
- Tickets it covers go in progress; a milestone launched whole loses its hand-set status.

- A session already working in the milestone's worktree makes the popover default to the ticket's own worktree, and a ticket that waits for unfinished ones says so; **Start N** on Up next starts every ready ticket of the current milestone at once, each in its own worktree (per-ticket maps only).

**The brief page** (`MapBrief.tsx`, `MapLaunches.previewBrief` over IPC `previewMapBrief`, which creates nothing): the ticket's objective, acceptance criteria and constraints; **Edit brief** changes the ticket itself, plus a note for this start only (`MapLaunchRequest.note`, kept on the session as `note` and added to its brief under "A note from the user for this start"). Beside it: readiness (`briefReadiness`: objective, criteria and source context included, and nothing it waits for still open; advisory, starting is never refused), the docs the brief points to (`ticketBriefDocs`: the ticket's sections, then its milestone's docs; **+ Attach context** links a doc or one of its headings to the ticket), and Session setup: Claude Code, where it runs (a new worktree and its predicted `manta/<slug>` branch from the project's current branch, or the worktree it already has; its own or the milestone's), the code project when there's a choice, and what the session may do (`permissionSummary` of the Claude command's flags, map tools, the map's checks). **Show the full brief** shows the text the session gets. Several briefs start as one batch and open Activity; one opens its session.

**The brief** (`launchBrief`): the map and milestone in a line or two, the ticket(s) in full with their acceptance criteria (indexed, for `wrap_up`) and what they wait for, paths of its docs and sections (not contents), the other sessions running in the same worktree (commit only your own paths), up to five wrap-ups of earlier work in the milestone, the worktree and branch, the commit trailer `Manta-Launch: <id>`, `WORKING_UNDER_A_MAP` (query the map, report status, journal as you go, propose plan changes rather than quietly departing, wrap up before stopping) and **Finishing** (`finishingSteps`: the project's checks from the map's settings, commits with the trailer, push and `gh pr create --draft`, report done and wrap up with `finished: true`).

### Each prompt (`MapLaunches.promptContext`)

Map sessions' `UserPromptSubmit` hook gets an answer: the hook command prints what the hook server replies, and `TerminalManager` asks `promptContext` for map sessions (bounded at 1 s). It returns a few lines of `additionalContext` when something in the session's scope moved since it last looked: its tickets edited (`map_ticket` to reread), its docs changed (content hashes), sibling launches in the milestone landed. It also sets tickets of its own that were blocked back to in progress, since the user typing into the session is the answer, and says so. A snapshot per terminal is taken when the brief is written and after each prompt.

### Map tools

Served from the hook server's MCP endpoint (`/mcp/<terminal id>` for sessions, `/mcp/agent_<…>` for Manta's own agents), allowed without prompts. `MapLaunches.toolsFor` picks them by caller (`mapTools.ts`):

| Tool | Session | Sweep | Ask | Coordinator |
|---|---|---|---|---|
| `map_outline`, `map_milestone`, `map_ticket`, `map_docs`, `map_journal` | ✓ | ✓ | ✓ | ✓ |
| `board` (every live launch, its batch first) | | | | ✓ |
| `report_progress` (phase, one-line summary, what it needs from the user, next) | ✓ | | | |
| `set_ticket_status` (in its launch's scope) | ✓ | ✓ | |
| `journal` | ✓ | | |
| `wrap_up` (summary, went to plan, finished, criteria judged; records `wrapUp`, `wrappedUpAt`, `readyAt`) | ✓ | ✓ | |
| `suggest_doc`, `suggest_doc_to_write`, `suggest_ticket` (`confirmed_with_user`: see below) | ✓ | ✓ | ✓ |
| `propose_plan_change` (update, add, move, remove tickets; update, move milestones) | ✓ | ✓ | ✓ |
| `propose_decision` (a question for the user, its `options` and the one recommended, a value it `requires`, its `docs`, the tickets it blocks; with `outcome` and `confirmed_with_user`, recorded decided) | ✓ | | ✓ |
| `propose_milestones` | | | ✓ |
| `propose_doc_change`, `revise_doc_change`, `withdraw_doc_change` | ✓ | ✓ | ✓ |

**Asking first** (`confirmProposals`, on by default; map settings: "Sessions ask me before proposing…"). With `ask`, the brief (`workingUnderAMap`) tells a session to collect its proposals and put them to the user with AskUserQuestion at a decision point or at wrap-up (one question each, up to four per call, what and why), and to raise only the accepted ones. `suggest_ticket`, `propose_plan_change` and `suggest_doc` with `confirmed_with_user: true` from a session then apply at once (`MapLaunches.suggestion`: raised, then resolved as accepted) and are journalled; if applying fails it stays in Needs review. Docs to write and doc changes always wait for the user in Manta. With `queue`, sessions raise proposals directly and they all wait in Needs review. The sweep, the landing pass and Ask the map always queue. Every prompt that can propose a doc change asks for the smallest edit that makes the doc right (`MINIMAL_DOC_CHANGES`), since later sessions read it. Every prompt that writes to the map (briefs, Ask the map, Break down, the sweep, the landing pass) asks for text read at a glance (`MAP_WRITING`: titles of a few words, descriptions and summaries of a sentence or two, no spec section numbers or paths), and the tool schemas set lengths on the fields the screens show (a milestone's description is one sentence; a ticket's title under eight words; a wrap-up's summary under 40 words; a doc to write gets a title, not a file name).

Doc proposals from map agents are ordinary doc threads with `proposedByMap: { map, from, title }`; their transcript says who proposed them. Implementation sessions keep their own doc tools (`Implementations`).

### Status from pull requests and landing (`MapLaunches.check`)

Run when a map's screen opens, on window focus, when one of its sessions comes to rest, and every 5 minutes in the background for every map with work not landed (`checkAll`; `gh` only, never an agent). For each launch not landed: look up its PR (`gh`), its health when it's open (`pullRequestDetail`: checks, reviews, threads), and check landing with `branchLanded` (trailer, or the tip on the default branch past `base`) or a merged PR. A PR opening puts the launch's tickets in review; landing marks a milestone launched whole `landed` and runs the landing pass, but leaves ticket statuses alone. Statuses change only on a change.

### Pull requests and their feedback

- **Open PR** (`openPullRequest`): for a launch with `readyAt` and no PR; main pushes the worktree's branch and runs `gh pr create --draft` (`PullRequests.createDraft`), titled after the scope, its body the wrap-up summary, the criteria ticked as judged and the trailer. The PR's number comes from `gh`'s URL, and the tickets go in review at once.
- **Send to session** (`sendFeedback`): failing checks (names, links, how to read the logs) or the review (unresolved, current threads and each reviewer's latest change request, through `formatPullRequestMessage`) go to the launch's running session, or start a resumed one with it as the first prompt. Noted in the journal. Needs review hides the item while the launch's session is working.

### The sweep

When a launch's session exits or its tab closes, and no session of the launch is still running, `maybeSweep` runs if the map has the sweep on and neither a wrap-up nor an earlier sweep covers the work since its last start (`needsSweep`). It's one turn of the thread agent with the model `haiku`, the journal, the branch's commit subjects and `--stat`, the PR's title and body when there is one, and the scope's acceptance criteria in its prompt, and only the map tools (read-only file tools aside, anything else is denied). It always records `sweptAt`. Sessions killed because Manta quits are never swept (`close()`).

**The landing pass** (`maybeLandingPass`, `landingPrompt`): once per launch, when it lands and the map has the sweep on, the same small agent checks the scope's docs against what landed (review fixes included) and proposes changes only where a doc is now wrong; it also sets statuses when nothing wrapped the work up. It records `landingSweptAt`.

### Activity

Every write to a map passes through three places in `WorkspaceMaps`, and each compares before and after and appends what changed to `activity.jsonl` (`core/maps/mapActivity.ts`): `changeTracker` (tickets done, blocked or in review, milestones done, decisions raised, decided, superseded or reopened; hand edits, tools and `setStatuses` alike), `saveLaunch` (an agent started, finished or wrapped up, a pull request opened or merged) and the suggestions (made, accepted, dismissed). Titles are kept as they were, so an event reads right after a rename. Doc changes proposed are read from their thread records (`proposedByMap`, kept after review), not logged. A map without a log is backfilled once from what it already dates (sessions started, wrap-ups, decisions raised and decided, suggestions waiting); when tickets were done before that isn't known, so it isn't made up.

**Activity** (`MapActivity.tsx`, `lib/mapActivity.ts`) leads with Since your last visit: the events after the later of the last visit and **Mark all as seen** (`markMapSeen`, `seenAt`), with reviews ready, doc changes proposed and blocking decisions counted. The log follows by day (today's entries as cards, older ones as rows; tickets done in one milestone in a row, or changes to one doc, grouped), filtered All / Agents / Docs / Decisions / Milestones, and **Needs action** keeps the entries whose subject still waits on the user. The picked entry shows in a panel with its way to act: an agent's state, worktree, what came back and its proposed doc change (**Review handoff** opens the ticket's review page), a decision (**Review decision**), doc changes (**Review in Docs**), a milestone's progress. The Overview's Since your last visit reads the same log, and its "Open agent sessions" opens Activity on Agents. Activity replaced the Board page.

### The board and a batch's coordinator

**Batches.** Tickets started together, each in its own worktree (**Start N**, or ticked tickets launched "each"), share a `batch` id the renderer makes up; `launch` records it on the launch and adds the batch to `batches.json`. The map's tabs then switch to **Activity**, on Agents.

**The board** (`shared/mapBoard.ts`, used by core and the renderer alike) has a row per live launch session: its title, the session's own last `report_progress` (phase, summary, next), its terminal's state, its pull request, and what it needs from the user, ranked: 0 waiting in its session or blocked, 1 a decision it asked for, 2 finished work to review or open a PR for, 3 a PR with failing checks or changes requested, 4 a PR approved and green, 5 nothing. Among equals, a ticket more others wait for (`after`) comes first. Sessions are told in the brief to report when their phase changes and to set `needs` before asking the user anything. The **Board** screen (Home links to it, with how many rows need you) groups rows by batch, newest first, then other work; a row opens its session.

**The coordinator** (`MapLaunches.coordinate`): offered for each batch on the Milestones page's **Agents** card (`MapAgents.tsx`, the board's rows by batch, then other work) and in Activity's detail panel for the batch's agent events (**Start coordinator** or **Not now**, which records `declined`). It is a tracked Claude session in the docs repo, its tab in the map's context, separate from Ask the map. Its brief (`coordinatorBrief`) gives the batch's tickets in a line each, the board as it is, and its job: tell the user what needs them, in order, and coordinate only (no code, docs, or map changes; read the board, not code or transcripts). Its tools are the read-only map tools and `board`. Opening it again returns its terminal, or resumes its session.

**Wake-ups.** Every map change and every map session's terminal change schedules one check per running coordinator, after `coordinatorDelayMs` (20 s) so a burst becomes one prompt. The check compares each row's signal (what it needs from the user, and whether its session is live: `signalOf`) with what the coordinator was last told; only rows that now need the user, ended, or landed are sent, as one prompt starting "Manta: changed since you last looked". Progress lines alone never wake it. A busy or waiting coordinator gets it when it's back at its prompt. What it was told resets with each brief (start or resume). Claude Code's own compaction keeps its context in check; the board, not its transcript, is what it reasons from.

### Ask the map and Break down

Ask the map is the map agent (`ThreadAgent` through its own `ThreadTurns`) with `askSystemPrompt`, the outline as its checkout (it never edits anything), and the map tools through `agent_ask_<map>`. **Break down** sends `breakDownPrompt` with the map's docs; the plan it proposes (`propose_milestones`) waits in Needs review and is approved whole or milestone by milestone.

### Needs review and Up next

Needs review (`needsReview`, renderer): doc proposals, suggestions (plans and plan changes approved item by item), sessions waiting for input, blocked tickets, finished work without a PR (**Open PR**), PRs with failing checks or review comments (**Send to session**), and other open PRs (**Review PR**; "approved: merge it" once approved with checks green). The Overview shows what its attention list doesn't act on as **Needs review** (`overviewReview`, `MapNeedsReview.tsx`): suggestions, approved or dismissed in place, blocked tickets, and open PRs not otherwise listed, each with its action. Several proposed changes to one doc open that doc on Docs; the suggestions item scrolls to Needs review.

The **Overview** (`MapOverview.tsx`, `lib/mapAttention.ts`) leads with **Recommended next**: what to do, why now ("Why this? Blocks 2 tickets") and who acts (Needs you, or Ready for an agent). It's the first of **Needs your attention** (`attentionItems`): open decisions and agents waiting for an answer first, ranked by the board's ranking and how many tickets each holds back; then work to review: a ticket's finished work (**Review**; a group's or milestone's, **Open PR**), open PRs (**Review**), merged work not yet done (**Verify**), the ticket ones opening its review page, doc changes (grouped by doc) and suggestions; then pull requests to fix or merge. With nothing there, it's the plan's next step from Up next (`homeUpNext`): a running session, ready tickets (**Start N** when several can run in parallel), a milestone, then Break down or Write a PRD. Below: the current milestone with only its tickets in motion (agent working or waiting, in review, blocked, paused), agents working and waiting (**Open agent sessions** opens Activity, the board), and on the side Feature context (docs by title and role, linked tickets, waiting changes), Decisions (open first, then the latest decided: `decisionSummaries`), and Since your last visit (`sinceLastVisit`, from `lastVisitedAt`), each showing three rows with Show all and folding to its header (remembered per map in this browser). **Decisions** (`MapDecisions.tsx`) has the register on the left (how many need you and how many tickets wait, search, Open / Decided / Superseded, the log, "A recommendation is not approval") and the picked decision on the right: who raised it and in which ticket (`raisedIn`), the question, the options to choose between (starting on the recommended one), the value it requires, connected docs, the work it holds, and **Confirm decision** once an option is chosen and the value filled in (or, without options, once the outcome is written). **Ask a question** opens Ask the map with the decision in the box (`askAbout`). A decided one can be **Mark superseded** or **Reopen**ed, and **Edit** changes every field, options and docs included. **Milestones** (`MapMilestones.tsx`, `lib/mapMilestones.ts`) is the plan: a strip of milestone cards (✓ done, Current, Next; click to select, the current one by default), the selected milestone's key, title, description and "3 of 11 done", and its tickets as a table: title with key and one meta line (`ticketMeta`: why it's held, "4 checks attached" once finished, "No dependencies", else its doc section), the work status pill and the agent's activity. Filters All open / Needs you (agent asking or an open decision) / Ready; done tickets are hidden until **Show done tickets**. **Select tickets** shows checkboxes and **Launch (N)**. Beside it, **Ready to start** offers the independent ready tickets (`independentTickets`: no `after` between them, no shared doc section) with **Review N briefs**; then the definition of done (tick, click to edit, add, remove) and the done count. Hand edits live in ⋯ menus and on right-click: rename, describe, reorder, pin as current, set status, start or remove a milestone; open, start, set status, reorder, move or remove a ticket; **+ Ticket** and **+ Milestone** add. **Review** (`MapReview.tsx`, `lib/mapReview.ts`) is a ticket's work across all its launches: the agent's state, worktree, checks passed and doc updates proposed (**Open session**); each wrap-up, newest first (**View changes**: its PR, else its session); the latest judgement of each acceptance criterion with its source (**View evidence**) and the checks run; what it didn't verify and its risks; and the doc changes its launches proposed, each with a preview (`changedLines`), the full diff, and **Include this update when marking done**. **Request changes** sends the user's text to the launch's session (`MapLaunches.requestChanges`, journaled). The next step follows the work (`ticketReview` stage): **Open pull request** once finished, **Review PR** (with **Send failing checks** / **Send PR review**) while it's open, and **Mark done & update map** once merged, or once finished on a shared branch (`MapLaunches.markDone`: approves the included doc changes, all or none, then sets done and journals the review). It opens from the Overview's Review and Verify items, an in-review row on Milestones, **Review the work** in a ticket's menu, and the ticket page. The ticket page has two columns: the title (typed into in place), its own Up next, the description (`MarkdownField`: live preview, saved on a click away or ⌘Enter), the acceptance criteria as last judged (an input each) and each launch's wrap-up and PR health on the left; Review the work, status, what it waits for, the docs it relies on and the code project on the right. Pickers across the map screens are `MultiSelect` dropdowns with keys (`M4`, `OMN-18`), not checkbox lists.

### Docs

**Docs** (`MapDocs.tsx`, `lib/mapDocs.ts`) follows the frame: the collection on the left (search, role filters for the roles the docs carry, a card per doc with its roles, proposed changes in amber, linked tickets and when it changed; **Context coverage**: product & technical plan, release guidance, design reference, each covered once the docs carry those roles) and a reader for the picked doc on the right. The reader edits the **Accepted version** in place: the doc's own editor (`Editor`, `embedded`), live preview, saving like a doc tab; a doc open in a tab too shares its typing through `lib/editorPeers.ts`, since main doesn't send an editor's own updates back. With one proposed change applied (`threadProposal`'s `merged`) it renders read-only (frontmatter and the title line dropped); the banner counts proposed changes with **Review changes**, which opens the proposal. **Ask about this** opens Ask the map; **Attach to ticket** picks tickets (`MultiSelect`) to add the doc to their `docs`, and each On this page row attaches its section, copies a markdown link to it, or jumps to it (`headingLine`). An open decision citing the doc shows as a notice; the rail lists On this page, Connected work (the doc's milestones and the tickets citing it) and the decisions citing it.

**+ Add document → New doc** takes a title, creates the doc headed by it in the docs repo (path from the title in the map's folder unless typed) and lists it; a doc to write that an agent suggested is headed by its suggested title the same way (`createDoc`'s `title`), optionally with a Brainstorm thread; **Existing doc** lists one; **Link a design or prototype** adds a web page (`add-link`: an http or https address and a title; its `path` is a `link:` key, never a file). Links open in the browser, appear in the map's outline for agents with their address, and are left out of briefs, `map_docs` and Break down. **Add to map…** on a doc's tab does the same from the doc. A card's ⋯ (or right-click) opens it in the editor or browser, removes it from the map (the doc stays), or **Edit details**: a link's title and address, roles, milestones, and its section (new, rename, remove).

In a map's context the right panel's Files tab (and its search) shows only the map's docs, with **Show all files** to see the whole docs repo (`useMapDocPaths`).

**Implementing a section of a map's doc** (the Implement dialog) defaults to **As a ticket on <map>**: a ticket in the current milestone linked to the section, launched like any other, so its status, journal and PR show on the map. **As an implementation thread** is still there.

## IPC

`listMaps`, `getMap`, `createMap`, `updateMap`, `removeMap` (native confirm), `editMapTracker`, `removeFromTracker` (native confirm when there are launches or tickets), `editMapDocs`, `createMapDoc`, `mapDocText`, `markMapSeen`, `resolveMapSuggestion`, `mapJournal`, `launchMapWork`, `openMapLaunch`, `checkMap`, `openMapPullRequest`, `sendMapFeedback`, `sendMapMessage`, `breakDownMap`, `cancelMapTurn`, `answerMapPermission`, `onMapEvent`. Arguments are validated in `core/maps/mapArgs.ts`. Changes to a map's local state (launches, suggestions) reach the renderer as `FilesChanged.maps`, since the watcher doesn't see `.git/`.

## Developing

- **Tests:** `core/maps/__tests__/` (model, briefs, IPC validators, migration), `core/__tests__/workspaceMaps.test.ts` (tracker and docs edits, suggestions, proposals, Ask the map, migration, remove), `core/__tests__/mapLaunches.test.ts` (launches with the scripted `claude`: worktrees, briefs, every tool from a session, PR and landing statuses, finished wrap-ups and opening a PR, PR health and sending feedback, prompt notes and unblocking through the real hook, the sweep and the landing pass and when they don't run, plan changes, resume, Ask the map's endpoint), `renderer/src/lib/__tests__/mapUpNext.test.ts`.
- **Fake agent** (`MANTA_FAKE_AGENT=1`): the sweep calls `wrap_up`; Ask the map proposes a two-milestone plan for Break down and suggests a doc for `suggest <path>`. The fake `claude` calls any tool with `tool <name> <json>`, and prints context a `UserPromptSubmit` hook adds as `Context: …`.
- **UI checks:** an isolated instance (`MANTA_USER_DATA` in `/tmp`, `--remote-debugging-port`) driven over CDP; the walk-through used for v2: create a map, add docs, Break down, approve the plan, Start a ticket, report and journal from the session, exit (sweep), open the ticket.

## Known limits

- Maps don't travel: `.manta/` is local until it gets its own ref (roadmap P7).
- Opening a doc section from a ticket opens the doc at its top, not at the heading.
- Implementation threads started from a map's docs as threads (not tickets) aren't shown on the map.
- Journals sit in `.manta/` now, but `.manta/` doesn't travel yet, so teammates don't see them.
- The background check runs every 5 minutes while Manta is open; nothing checks while it's closed.
