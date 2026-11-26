# P12. Orca polish: design

Six quality-of-life features borrowed from Orca, done before P9 ([roadmap.md](../../roadmap.md)). Orca's source is at `~/Code/Cachalot/orca` (a stripped fork; paths below are relative to its `src/`). Where this says "my call", the user didn't decide it and can overrule it.

## Why

The user works across several worktrees at once, reviews agents' work and teammates' PRs, and sends feedback back to agents. Today Manta makes each of those a detour: back only works inside one worktree, the Branch tab compares against one fixed branch, PRs show only on implementation chips, and feedback reaches an agent only by typing it into its terminal. Orca already handles these well. These are polish items the user wants before Manta's bigger roadmap items.

**Success:** the user can move between worktrees and back without thinking, review a PR end to end inside Manta, and turn any review comment, their own or a teammate's, into agent work in two clicks.

## Goals

1. **G-A. Dismiss map suggestions.**
2. **G-B. One back and forward history across the whole app.**
3. **G-C. Choose the branch the Branch tab compares against.**
4. **G-D. Comment on diff lines and send the comments to an agent**, one at a time or as a batch.
5. **G-E. A PR tab:** the branch's PR, its CI checks and its comments; send teammates' comments to an agent with the user's own prompt template; create a draft PR.
6. **G-F. Review a PR in Manta:** go through its files ticking each as viewed, comment on lines (one comment at a time or as a review), and submit the review.

## Non-goals (this round)

- Reviewing a PR whose branch has no worktree in Manta. The PR is always the one `gh` finds for a worktree's branch. To review a teammate's PR, the user creates a worktree on its branch first (the user's call). A list of PRs awaiting review, reviewable without a worktree, is a future consideration (about 1–2 days more: the diff from GitHub instead of a checkout).
- Replying to, resolving or reacting to existing GitHub comment threads. The first version reads them and sends them to agents. The user plans more PR features later.
- Merging PRs, re-running CI, editing the PR's title or description.
- GitLab or other hosts. GitHub through the user's own `gh`, as today.
- Sending to agents that aren't Claude sessions Manta tracks (plain shells, the threads' own agent).

## Anti-goals

- **Busy UI.** The mockups were a layout sketch. The real thing should be minimal and clean, in Manta's existing style: few borders, muted secondary text, icons over labelled buttons where the meaning is clear.
- **Stealing focus.** Sending to an agent never switches tabs. The agent's tab shows its working indicator where it is.
- **Surprise writes to GitHub.** Comments made while reviewing an agent's work in a worktree stay in Manta, even when the branch has a PR. Only comments written in a PR review go to GitHub.
- **Answering a permission prompt by accident.** Text sent into a Claude session that is waiting on a permission prompt would answer it. Don't send to those (see G-D).

## Order and size

Smallest and most independent first. G-D builds the comment gutter and agent picker that G-E and G-F reuse.

| Step | Feature | Effort |
|---|---|---|
| 1 | G-A Dismiss map suggestions | 2–3 h |
| 2 | G-B Back and forward | 1 day |
| 3 | G-C Compare branch picker | 0.5–1 day |
| 4 | G-D Diff comments to agents | 2–3 days |
| 5 | G-E PR tab, checks, comments to agents, draft PR | 2–3 days |
| 6 | G-F PR review | 3–4 days |

Each step ships on its own, with typecheck, tests and the folder READMEs updated, like P10's stages.

---

## G-A. Dismiss map suggestions

**Today:** `core/maps/mapSuggestions.ts` (`suggestMaps`) picks up to 3 folders of the docs repo with two or more docs no map covers. The sidebar lists them under **New context map** (`Sidebar.tsx`, `.map-suggestion` rows). Clicking one opens `NewMapDialog` prefilled.

**Decided:**
- A suggestion row shows an × on hover, and right-click gives **Dismiss** (`ContextMenu.tsx`).
- A dismissed folder stays dismissed for that docs repo, and the next suggestion takes its place.
- A way to bring dismissed ones back: **Show dismissed suggestions** at the bottom of the right-click menu, which lists them, each with **Restore**.

**My calls:**
- Dismissals are kept in `.manta/maps/dismissed.json` (a sorted list of folder paths), with the rest of `.manta/`, so they travel with it once `.manta/` gets its own ref. Written atomically through the serial queue like other `.manta/` writes ([patterns.md](../../patterns.md)).
- `suggestMaps` takes the dismissed folders as one more input and skips them before taking the top 3. That keeps it pure and testable.
- A dismissal is by folder path. If the folder is renamed, its suggestion can come back. That's acceptable.

**Tests:** `mapSuggestions.test.ts` covers dismissed folders being skipped and the next one moving up. The store test covers a dismissal surviving a reload.

## G-B. Back and forward across the whole app

**Today:** `App.tsx` keeps a `history: Tab[]` per tab set (one per context root, plus maps), capped at 50. `goBack` (`App.tsx:622`) pops within the current context only. There is no forward.

**Decided:**
- One history for the whole window. An entry is a place: a context (docs repo, worktree, map) and the tab active in it. Back takes you to the previous place, switching worktree or context if needed. Forward undoes a back.
- Back and forward arrows, like Orca's (the screenshot the user shared), in place of today's Back button in the main header (`App.tsx`, `title="Back"`). Disabled when there is nowhere to go.
- Keyboard shortcuts and the mouse's back and forward buttons also work. The shortcuts are ⌘[ and ⌘] (the user's choice).
- Going back to a tab you've since closed reopens it, as Manta's back does today.

**My calls:**
- Model it on Orca's `store/slices/worktree-nav-history.ts`: a linear list and an index, where navigating somewhere new drops everything after the index, plus an "is navigating history" flag so a history-driven switch doesn't record itself. Cap at 50, like both apps.
- Record an entry when the active tab or the context changes, not on every keystroke or scroll. Collapse repeats: switching away from A and straight back to A doesn't add two entries.
- Skip entries that can't be restored: a worktree that was removed, or a map that was deleted. A terminal tab whose terminal is gone also gets skipped (this matches today's pruning at `App.tsx:533`).
- Keep the history in memory for the window, not across relaunches. Orca does the same.
- Put the logic in `renderer/src/lib/navHistory.ts` as pure functions (record, back, forward, prune) with tests in `lib/__tests__/navHistory.test.ts`. `App.tsx` holds the state and applies an entry, since tabs and contexts live there until G5 moves app state into a store.
- The per-tab-set `history` stays only for what it's also used for, picking a tab when one closes. If nothing else uses it, remove it.
- **Shortcuts:** ⌘[ and ⌘] go through the app menu (`appMenu()` in `src/main/index.ts`, as File → Close Tab does), as Go → Back and Go → Forward, so they work from a terminal too. In the code editor, ⌘[ and ⌘] are CodeMirror's outdent and indent (`indentWithTab` keeps Tab and Shift+Tab for that). The menu accelerator takes them first, as in VS Code. (Orca uses ⌘⌥← and ⌘⌥→; the user prefers ⌘[ and ⌘].) Mouse buttons arrive as `mouseup` with `button` 3 and 4 in the renderer.

## G-C. Compare branch picker

**Today:** the Branch tab (`BranchPanel.tsx`) shows "Committed on branch vs <label>", computed in `Git.branchBase()` (`git.ts:463`): the merge-base of HEAD and `baseBranch()`, which is `origin/HEAD`, then the main checkout's branch, then `main`/`master`.

**Decided:**
- The "vs <branch>" label becomes a picker. It searches local and remote branches. Picking one recomputes the tab against it.
- Each worktree remembers its choice. With no choice made, the default is today's.
- The Changes tab stays as it is: it shows uncommitted work against HEAD, where a base branch doesn't apply.

**My calls:**
- The comparison stays a merge-base (three-dot) diff, as now, so the tab shows what this branch did, not what the other branch did since.
- The choice is kept per worktree path in `<userData>`, next to other per-machine state. If the chosen branch no longer exists, fall back to the default and say so in the picker.
- `branch(root)` gets an optional `base` ref. The main process validates it as an existing ref before it reaches git, as a guard for outside data. A **Reset to default** item sits at the top of the picker.
- The picker lists recent branches first (by committer date, `git for-each-ref --sort=-committerdate`), then the rest, filtered as you type. Orca's `components/settings/BaseRefPicker.tsx` is the reference.
- The diffs the tab opens (`CompareView`) take their `from` from the chosen base, so they follow the choice too.

## G-D. Diff comments to agents

The core of the user's review workflow for agent work: comment on lines of a diff and hand them to an agent.

**Where:** every diff Manta shows. The Branch tab's read-only diffs (`CompareView.tsx`, `unifiedMergeView`), the Changes tab's diffs (the editor's `diff` mode in `Editor.tsx`), and later the PR review's diffs (G-F).

**Decided:**
- Hovering a line in a diff shows a **+** in the left margin. Clicking it opens a comment box under the line.
- A comment can be sent straight away with its send icon. You pick an agent, and it goes to that agent alone.
- Or comments build up as unsent in the right panel, and you send them together.
- The agent picker lists every open Claude agent across Manta. The one in the same worktree is first.
- Sending submits the text to the agent's prompt, so it starts working. Manta does **not** switch to the agent's tab. Its working indicator shows on the tab and in the sidebar.
- No prompt template here. That's only for PR comments (G-E).
- These comments stay in Manta. They never go to GitHub, even if the branch has a PR.

**My calls:**
- **What's sent:** a short header and one block per comment, with the file path, line range, the few lines of the diff it's on, and the comment.

  ````
  Review comments on your changes in <worktree>:

  1. src/login/Login.tsx:41
  ```diff
  - await login(email, password)
  + const result = await login(email, password)
  ```
  This swallows the network error. Can we surface it?
  ````
- **How it's sent:** a bracketed paste of the text, then Enter. Orca's `lib/agent-paste-draft.ts` does the same with a 50 ms gap before Enter and one retry for Claude. Do it in main (`TerminalManager`, beside `writeTerminal`), so it works when the agent's tab isn't mounted. It refuses (an `OpResult`) when the terminal isn't a live Claude session.
- **Agent state:** Claude Code takes a message while it's working and runs it next, so `working` and `idle` sessions can both be sent to. Sessions `waiting` on a permission prompt are listed but disabled, with "Waiting for you", per the anti-goal. Exited sessions aren't listed. Still `starting`: listed but disabled.
- **The picker:** a small popover from the send icon. Each row shows the agent's tab title, its worktree or context, and its state dot (the same dot as the sidebar). The same-worktree agents come first, then the rest by most recent activity. Mirrors Orca's `components/editor/ReviewNotesSendMenuContent.tsx`. If no agent is open, the popover offers **New Claude session in this worktree** and sends there once it's ready.
- **Where unsent comments show:** a **Comments** section at the top of the Changes and Branch tabs, only when there are any. Each one shows file:line and the first line of the text, with a checkbox. **Send N to agent…** sends the checked ones as one message. Clicking a comment opens its diff at the line.
- **After sending:** a comment is marked sent (greyed, with the agent's name) and drops off the list after a while, or on **Clear sent**. Comments can be edited and deleted until sent.
- **Anchoring:** a comment is anchored to the file, the side (old or new) and the line in that diff, plus the line's text. If the diff changes and the line's text no longer matches, the comment shows as outdated but is kept. Not a CRDT anchor. These are short-lived notes, not doc threads.
- **Storage:** per worktree, in the repo's common git dir (`<git-common-dir>/manta/review-comments/<worktree name>.json`), the way maps keep machine state under `.git/manta/` in the docs repo. Removing the worktree removes its file. Written atomically through the serial queue.
- **The gutter:** a CodeMirror `gutter` extension with a hover marker, shared by `CompareView`, the editor's diff mode and G-F's diff, in `renderer/src/lib/commentGutter.ts`. Comment boxes are block widgets under the line. With `unifiedMergeView`, deleted lines are widgets, not document lines, so commenting on a deleted line needs the deleted chunk's widget to carry its own +. Check that's possible with `@codemirror/merge` early. If it isn't, the first version allows comments on new and unchanged lines only, and says so.

**Tests:** the message format and the agent ordering as pure functions in `lib/`. Storage round trips in core. The send path end to end with the scripted agent (`MANTA_FAKE_AGENT=1`, `scripts/fake-claude.mjs`) to check the text arrives as one submitted prompt. A UI e2e that adds a comment, sends it, and sees the agent's state go to `working` without the active tab changing.

## G-E. The PR tab

**Today:** `core/repo/github.ts` (`ghPullRequests`) runs `gh pr list --head <branch> --state all --json number,state,url --limit 1`, cached 60 s. Only implementation chips show the result.

**Decided:**
- The right panel gets a **PR** tab, after Files, Changes and Branch, for worktrees.
- It shows the branch's PR: title, number, state (open, draft, merged, closed), base branch, **Open on GitHub**, and **Review files** (G-F).
- **Checks:** each CI check with its state (passed, failed, running), and a link to its logs.
- **Comments:** the PR's conversation and its review comments, unresolved first. Each has a checkbox.
- **Send N to agent…** sends the checked comments to an agent picked as in G-D, with the user's prompt template in front of them.
- **The prompt template:** the first time PR comments are sent, a popup asks for it and sends. After that it isn't asked again but can be changed. The user's own would be something like: "Analyse these PR comments, assign a reference to each like C1, C2, C3… Create a table with what can be addressed with your recommendations, split actionable items from items which require more thought."
- **Raise a draft:** with no PR on the branch, the tab offers **Create draft PR**.
- As in G-D, sending doesn't switch tabs.

**My calls:**
- **Fetching:** one `gh pr view <number> --json number,title,state,isDraft,url,baseRefName,headRefName,headRefOid,body,comments,reviews,statusCheckRollup` for the PR. Unresolved review threads need GraphQL (`gh api graphql`, `pullRequest.reviewThreads { isResolved, isOutdated, path, line, comments { author, body, diffHunk, url } }`). Keep `ghPullRequests` for finding the PR, and add a `ghPullRequestDetail` beside it in `core/repo/github.ts`. Every field from `gh` is parsed with guards, never cast.
- **Refresh:** when the tab opens, on window focus, and every 30 s while it's showing and a check is running. Otherwise reuse the cached answer for 60 s, like today. A refresh button for impatience. Orca's `pr-refresh-coordinator.ts` and `components/right-sidebar/checks-panel/` are the reference.
- **The template:** a default is filled in the first time (the user's wording above), so the popup is one click for them. It's kept in `<userData>/review-settings.json`, global rather than per repo. Manta has no settings page, so it's changed from an **Edit prompt…** link in the send popover.
- **What's sent:** the template, then the comments in G-D's format, each with its author, its file:line and diff hunk for review comments, and its URL. Conversation comments have no file.
- **Create draft PR:** a small dialog with title (default: the last commit's subject) and body (default: empty), base (default: the G-C choice, else today's default). It pushes the branch with `-u` if it has no upstream, then runs `gh pr create --draft`. Errors from `gh` are shown as they come.
- **The tab:** shown only for worktrees whose repo has a GitHub remote and when `gh` is installed. Otherwise the tab says why, once, rather than being missing without explanation.
- **Comments in G-D's list:** a PR's comments are not mixed into the Changes and Branch tabs' **Comments** section. They have their own list here. Two lists, one picker.

**Tests:** parsing `gh` output (recorded JSON fixtures for a PR with failing, passing and running checks, resolved and unresolved threads). The template's first-send flow. The send format. Pushing and `gh pr create` are behind the same injectable runner `ghPullRequests` uses, so tests don't reach GitHub.

## G-F. PR review

**Decided:**
- **Review files** on the PR tab opens the review as a tab in the middle: the changed files on the left, the selected file's diff on the right.
- Each file can be ticked as viewed. A count shows how many of how many are viewed.
- Commenting works as in G-D (the + in the margin), but the comment box offers **Add single comment**, which posts it to GitHub at once, and **Start a review**, which holds it in a pending review. Once a review is started, the box offers **Add review comment**.
- A **Finish review** button with the pending count submits the review: a summary and comment, approve, or request changes, as on GitHub.
- The box also has **Send to agent…**, as in G-D.

**My calls:**
- **Which diff:** the PR's own, base to head on GitHub (`baseRefOid`…`headRefOid`), not the worktree's working copy, because line comments must anchor to the PR's head commit. Fetch the PR's head into a hidden ref (`git fetch origin pull/<n>/head:refs/manta/pr/<n>`) and diff with the same merge-base logic as the Branch tab. If the worktree has unpushed commits, the review tab notes that it shows what's on GitHub.
- **Viewed (the user's choice):** kept in Manta first, per PR and file, in the same per-worktree file as the comments, and cleared for a file when its diff changes. Then, as the last step of G-F, mirror it to GitHub's own viewed state (GraphQL `markFileAsViewed` / `unmarkFileAsViewed`, read from `files { path, viewerViewedState }`) so it matches github.com both ways. If that turns out unreliable through `gh`, Manta-only stays.
- **The pending review:** held in Manta until **Finish review**, then submitted in one `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with all the comments and the event. That avoids a server-side pending review getting out of step with Manta. Kept in the same per-worktree file as G-D's comments, so it survives a relaunch.
- **Single comments:** `POST /repos/{owner}/{repo}/pulls/{n}/comments` with `commit_id` (the head), `path`, `line` and `side`.
- **Existing comments** on the diff show inline, read-only, under their lines (from G-E's review threads), so the reviewer sees what's been said.
- **The tab:** a new tab kind beside compare and map tabs in `App.tsx`. The diff reuses `CompareView` with the comment gutter. The file list is a list with checkboxes, in the style of the Changes tab's rows.
- **Your own PR:** GitHub doesn't allow approving or requesting changes on your own PR. **Finish review** offers only Comment then.

**Tests:** request bodies for single comments and reviews built by pure functions and checked against fixtures. The fetch-and-diff path with a real temp repo standing in for the remote, as the git tests do. The `gh` calls behind the injectable runner.

---

## What's left to the builder

- Exact styling, icons and spacing, within the anti-goal above.
- Names of new files, IPC channels and types, following `src/README.md` and the folders' READMEs (update each README table in the same change).
- Where in `App.tsx` state lives until G5. Don't start G5 for this.
- Whether G-D's deleted-line comments are possible with `@codemirror/merge`, as described above.
- Docs: a section in [terminals.md](../../terminals.md) for sending to agents, and a new `docs/reviews.md` for G-D to G-F once built, like the other feature docs.
