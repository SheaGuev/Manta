# Review comments

How review comments work in Manta, for anyone changing them. Built for roadmap item P12, steps G-D (diff comments), G-E (the PR tab) and G-F (PR review) ([roadmap.md](roadmap.md)). The design: [superpowers/specs/2026-10-26-orca-polish-design.md](superpowers/specs/2026-10-26-orca-polish-design.md), sections G-D to G-F.

## What they are

Notes on lines of a diff that the user hands to a Claude session to act on: reviewing an agent's work, line by line, without retyping where each remark applies.

- **Where:** the branch's whole diff (the compare tabs opened from **Committed on branch**, `CompareView` with `review`) and the Changes tab's diff tabs (the editor's `diff` mode). A single commit's compare tab takes none: its line numbers are that commit's, so its comments would land in the wrong place in the branch's diff. G-F's PR review reuses the same gutter.
- **Lines on both sides:** new and unchanged lines, and deleted lines (the rows the merge view draws above a change).
- **Sent two ways:** straight away from the comment box's send icon, or collected in the right panel and sent as one message.
- **Kept in Manta.** They never go to GitHub, even when the branch has a pull request. No prompt template: that's only for PR comments (G-E).

## Data model

One file per worktree, `<git-dir>/manta/review-comments.json`. `--git-dir` is per worktree (`.git/worktrees/<name>` for a linked one), so removing the worktree removes its comments.

```json
{ "comments": [ { "id": "rc_<12 hex>", "relPath": "src/b.ts", "diff": "branch", "side": "old", "line": 1,
  "lineText": "export const b = 2", "hunk": "-export const b = 2\n+export function total…",
  "body": "Why drop b?", "createdAt": "…", "sent": { "to": "Claude 2", "at": "…" } } ] }
```

- `diff` is `changes` (uncommitted, vs HEAD) or `branch` (the Branch tab's comparison); each tab lists only its own.
- `side` and `line` name the line in that diff: `new` is the current file's line, `old` the original's (a deleted line).
- `lineText` is the line's text when the comment was made; `hunk` is two rows of the unified diff either side, prefixed `+`, `-` or a space, as the agent will see it.
- `sent` is the agent's tab title once sent; sent comments stay, greyed, until **Clear sent**.

`ReviewCommentStore` (`core/review/reviewComments.ts`) runs every call on its own queue and writes atomically. An unreadable file reads as empty and the next write replaces it; unreadable entries are skipped (`parseComment`).

## The message

`formatReviewMessage` (`core/review/reviewMessage.ts`):

````
Review comments on your changes in <worktree folder>:

1. src/b.ts:1 (old side, removed line)
```diff
-export const b = 2
+export function total(items: number[]): number {
```
Why drop b?

2. src/b.ts:5
…
````

The fence grows past any backtick run in the hunk (`fenced` in `core/threads/implementationBrief.ts`).

## Sending

`sendReview` (`core/review/sendReview.ts`), behind `review:send`:

- **To a running session:** `TerminalManager.sendPrompt` pastes the message (bracketed paste, then Enter) into the Claude terminal, in main, so it works when the tab isn't mounted. Refused, with nothing typed, for a shell, an exited or starting session, and one waiting on a permission prompt (the text would answer it). It checks again before pressing Enter, and presses it once more if an idle session doesn't start working; when it can't submit, it says so and the comments stay unsent. Details: [terminals.md](terminals.md) → Sending a prompt.
- **To a new session:** `TerminalManager.create(root, 'claude', …, { prompt })` starts one in the worktree with the message as its first prompt.
- On success the comments are marked sent to that session's title. A refusal leaves them unsent and its message shows in the status bar.
- **Manta never switches tabs.** The session's hooks move it to `working`, which its tab dot and sidebar row show.

## Renderer

| Piece | File | What it does |
|---|---|---|
| Gutter and boxes | `lib/commentGutter.ts` | A CodeMirror extension: a **+** in its own gutter beside the hovered line, or beside the hovered row of a deletion (through `widgetMarker`, one row per deleted line). Clicking it opens a comment box (a block widget under the line, or after the deleted rows): **Comment**, the send icon, **Cancel**; Escape cancels, ⌘Enter saves. Saved comments are compact widgets under their line, with "outdated", "sent to …" and ×. |
| Anchors | `lib/reviewAnchors.ts` | `newLineAnchor`, `deletedRowAnchor` and `placeComments`, pure over the merge view's state (`getChunks`, `getOriginalDoc`). A comment whose line text no longer matches, or whose line is gone, is kept and shown as outdated at the nearest line. |
| Wiring | `components/DiffComments.tsx` | `useDiffComments`: the extension, the comments for the view's file and diff (`setReviewComments`), and the picker for a send. Used by `CompareView` and `Editor` in diff mode. |
| Agent picker | `components/AgentPicker.tsx`, `lib/agentTargets.ts` | Every open Claude session, the worktree's own first, then the most recently started; waiting and starting ones are listed but disabled; **New Claude session here** last. |
| Comments section | `components/ReviewComments.tsx` | At the top of the Changes and Branch tabs, only when that diff has comments. Checkbox per comment (unsent ones ticked), `file:line` and the first line, **Send N to agent…**, **Clear sent**. A row opens its diff; the Changes diff scrolls to the line (an old-side line to where its deleted rows are drawn, `lineToReveal`). |
| Data | `lib/hooks.ts` (`useReviewComments`) | Reloads when main sends `review:changed` for the root. |

Gotchas:

- **Block widgets are measured without their margins.** CodeMirror's height map uses `offsetHeight`, so spacing around a comment is the wrapper's padding (`.cm-reviewWidget`); a margin pushes the line numbers out of line.
- **Deletion widgets aren't exported** by `@codemirror/merge`. A block widget that isn't ours, sitting at a chunk's `fromB` with deleted lines, is one.
- Hover is tracked on `view.dom` (the gutter isn't in the content DOM), and dispatched straight from the listener: DOM events never run inside a CodeMirror update.

## IPC

`reviewComments`, `addReviewComment` (main checks the anchor with `reviewAnchor`), `editReviewComment`, `removeReviewComments`, `sendReviewComments` (an `OpResult`). Streamed: `review:changed` (`root`), sent after every change.

## Tests

`core/review/__tests__/` (the store, the message, sending with the scripted `claude`), `core/terminal/__tests__/terminals.test.ts` (`sendPrompt`: one prompt for a multi-line paste, refusals), `renderer/src/lib/__tests__/reviewAnchors.test.ts` and `agentTargets.test.ts`. The UI is checked by eye through CDP on an isolated instance (`docs/threads.md` → Developing).

## Known limits

- No editing a saved comment yet (delete it and write it again); `editReviewComment` is there for it.
- Clicking a Branch-tab comment opens its compare tab but doesn't scroll to the line.
- Line anchors aren't CRDT anchors: they follow line numbers and text, so a heavily rewritten file shows its comments as outdated.

## The PR tab

The right panel's **PR** tab, for code worktrees (beside Branch), shows the branch's pull request: its title, state, base, CI checks and comments. Ticked comments go to a Claude agent behind the user's prompt template, through the same picker and delivery as review comments. With no PR, it offers **Create draft PR**. It reads GitHub through the user's own `gh`, and creating a draft is the only thing it writes.

**Fetching** (`ghPullRequestDetail` in `core/repo/github.ts`):

1. `gh pr list --head <branch> --state all --json number --limit 1` finds the PR.
2. `gh pr view <n> --json id,number,title,state,isDraft,url,baseRefName,baseRefOid,headRefName,headRefOid,author,comments,reviews,statusCheckRollup` reads it.
3. One `gh api graphql` query reads `viewer { login }` and the review threads (`reviewThreads(first: 100)`, 50 comments each), which `gh pr view` doesn't have. `{owner}` and `{repo}` are filled in by `gh` from the folder's remote.

Everything is parsed with guards (`parsePullRequestDetail`); an entry it doesn't recognise is skipped with a `console.error`, and a top level it doesn't recognise is reported as "gh's answer wasn't understood". A failed `gh` is never read as "no PR", so the tab can't offer a draft for a branch that has one. Every call goes through `ghRunner`: prompts off (`GH_PROMPT_DISABLED=1`), a 20 s timeout, stdin closed.

**When it can't work** (`PullRequests.status` in `core/review/pullRequests.ts`), the tab says why, wrapped in full: `gh` isn't installed, the worktree isn't on a branch, or `gh`'s own error (not logged in, offline). `gh` is asked even when no remote looks like github.com, because only it can place an ssh host alias (`git@github-work:o/r`); when it fails and no remote is on github.com, the reason is "This repo has no GitHub remote". While the first answer is on its way, the tab says it's looking. A refresh that fails while a PR is showing keeps the PR and shows the error under its header (`nextStatus`), so a network blip doesn't blank the tab or stop the 30 s refresh.

**Refresh:** when the tab opens and on window focus, from a 60 s cache per worktree and branch; every 30 s past the cache while a check is running; at once from the refresh button or after creating a draft. One request at a time (`usePullRequest`).

**Comments:** unresolved threads first by file and line (outdated ones struck through, after current ones), then the conversation and review summaries oldest first, then resolved threads in a collapsed group. Unresolved current threads start ticked, so sending them is two clicks. Ticks are kept per worktree and PR (`localStorage`), so switching tabs or relaunching keeps them, and **Send N** counts only ticked comments in sight: a thread resolved since it was ticked isn't sent from a closed Resolved group (`chosenToSend`). Sent ones show "sent to X" (kept in the worktree's review file as `prSent`, by GitHub node id) and are unticked; they can be ticked and sent again.

**The template** is kept in `<userData>/review-settings.json` (`ReviewSettings`), for all repos. Until the user has saved one, the first send opens it filled with the default ("Analyse these PR comments, assign a reference to each like C1, C2, C3…"), and **Send** saves it and sends. After that it's changed from **Edit prompt…** under the agent picker.

**The message** (`formatPullRequestMessage`):

````
<template>

Comments on PR #7 "Add login" (<url>), for your changes in <worktree folder>:

1. @dave on src/login.ts:14 (<thread url>)
```diff
<diff hunk>
```
Handle the error here

@alice replied: Will do

2. @carol commented (<url>)
Can we split this PR?

3. @dave reviewed, changes requested (<pr url>)
Needs tests
````

A thread's place gets ` (old side)` and ` (outdated)` when they apply.

**Create draft PR** (`PullRequests.createDraft`): a dialog with the title (the last commit's subject), the base (the Branch tab's compare choice without its remote's name, else the default branch) and an empty description. It pushes with `-u origin <branch>` when there's no upstream, or pushes when the branch is ahead of it, then runs `gh pr create --draft --title … --body … --base … --head <branch>` (`--head` keeps `gh` from asking where to push). When the branch was pushed to a fork of the repo `gh` opens PRs on (`gh repo view --json nameWithOwner`), the head is `<fork owner>:<branch>`; `repoOfUrl` reads `owner/repo` from any remote URL, ssh host aliases included. A refused push or a `gh` error shows in the dialog as it came, and no PR is made after a failed push. The push never waits on a prompt (`Git.pushBranch`): it runs in its own session with no terminal, so ssh can't ask about a host key, with `GIT_TERMINAL_PROMPT=0`, and gives up after 90 s. Cancel works while it runs; an outcome that arrives after the dialog closed goes to the status bar.

**IPC:** `pullRequest(root, force)`, `pullRequestSent`, `sendPullRequestComments` (reads the PR main last fetched for that worktree, so ids can't name comments the user never saw), `prTemplate`, `setPrTemplate`, `draftPullRequestDefaults`, `createDraftPullRequest`. Sent marks refresh through `review:changed`.

**Checking it by eye:** `MANTA_FAKE_GH=<script>` makes main run that script instead of `gh`. A stand-in that prints the fixtures in `core/repo/__tests__/fixtures/` for `pr view` and `api graphql` gives the found state, and a bare local `origin` takes the draft's push.

**Tests:** `core/repo/__tests__/github.test.ts` (parsing against the fixtures, the call order and cache, a failure never reading as no PR, the runner's stdin and prompt setting), `core/review/__tests__/pullRequests.test.ts` (availability reasons, draft defaults, push then create against a bare temp origin, a refused push, a new PR found straight away), `reviewSettings.test.ts`, `pullRequestMessage.test.ts`, `sendReview.test.ts` (PR comments through the scripted `claude`), `renderer/src/lib/__tests__/pullRequestView.test.ts`.

**Known limits:** github.com only; the first 100 review threads and 50 comments per thread; `gh` gives reviews no URL, so a review links to the PR; replying to or resolving threads happens on GitHub.

## PR review

**Review files** (the file-search icon in the PR tab's header) opens a **Review #n** tab in the middle. It lists the PR's changed files on the left, each with a viewed tick and an "N of M viewed" count, and shows the selected file's diff on the right. Ticking a file moves on to the next one not yet viewed. Single comments and the submitted review go to GitHub; nothing else does.

**The diff** (`fetchPullRequestDiff` in `core/review/pullRequestReview.ts`):

1. `git fetch <remote> +refs/pull/<n>/head:refs/manta/pr/<n> +refs/heads/<base>:refs/remotes/<remote>/<base>` fetches the PR's head into a hidden ref (outside `refs/heads` and `refs/remotes`, so no branch list shows it) and its base. `<remote>` is the one whose URL points at the PR's repo (read from the PR's URL), so it's `upstream` when `origin` is your fork; `origin` when none does. This works for PRs from forks too.
2. The diff runs from `merge-base(head, <remote>/<base>)` to that head, as GitHub draws it, not the worktree's working copy. When the worktree has commits the head doesn't, the tab says it shows what's on GitHub.

The tab reopens when the PR's head moves (`headRefOid` from the PR tab's data). `CompareView` draws each file with `usePullRequestComments` as its gutter.

**Where a comment can go:** GitHub takes line comments only inside the diff's hunks, so the **+** shows only there. `hunkRanges` reads the ranges from `git diff --no-ext-diff --no-color --no-textconv -U3 -M base head -- [<old path>] <file>` (`pr:commentable`), per side, and the gutter's `canComment` checks them. The flags keep a user's external diff tool or colour setting from hiding the `@@` headers. Until the ranges load, no line takes a comment. A renamed file is diffed against its old path, as GitHub does: `CompareView` reads the old side at `fromPath`, its hunks are of its edits, and the submit check reads a pending old-side comment's line at the old path. GitHub keys both sides' comments by the new path.

**The comment box** offers:
- **Add single comment:** posted at once with `gh api --method POST repos/{owner}/{repo}/pulls/<n>/comments --input -`. The body is `{ body, commit_id: <head>, path, line, side: LEFT | RIGHT }` (`singleCommentRequest`).
- **Start a review**, then **Add review comment** once one is pending: kept in Manta as an ordinary review comment with `diff: 'pr:<n>'`, in the worktree's review file. So it survives a relaunch, shows as "pending" under its line, goes outdated like any other comment, and never shows in the Changes or Branch lists.
- **The send icon:** gives the comment to an agent through the picker without storing it (`sendReviewDraft`), so it can't be mistaken for a pending GitHub comment.

**Existing threads** from the PR tab's data show read-only under their lines (`placeThreads`): new-side ones under the line, old-side ones under their deleted row, or under the shared line when it's unchanged. Outdated threads stay in the PR tab's list.

**Finish review** (with the pending count) asks for a summary and Comment, Approve or Request changes; on your own PR only Comment (GitHub refuses the others, and core does too). `PullRequestReviews.submit` checks, in order:

1. `reviewProblem`: an own-PR verdict, Request changes with no summary, or a Comment with neither summary nor comments.
2. That every pending comment's line still reads as it did (`staleComments`, against the base or head the tab shows, splitting CRLF files the way the editor does). If the author pushed and moved a line, it refuses and names the comments rather than post them against an old commit.
3. That every pending comment's line is still inside the diff. GitHub refuses a whole review over one comment outside it, after a revert or when the file has left the PR. Pending comments on files no longer in the PR are listed above the file list so they can be deleted.

Then it sends one `POST …/pulls/<n>/reviews` with `{ commit_id, event, body, comments }` (`reviewRequest`). The pending comments are removed only when GitHub took it. After a single comment or a review, main sends `pr:changed` and the PR tab refreshes past its cache.

**Viewed:** kept in Manta per PR and file, as the file's old and new blob ids (`Git.diffBlobs`), so a tick holds only while the file's diff is unchanged. Each tick goes to GitHub with the `markFileAsViewed` / `unmarkFileAsViewed` mutations (on the PR's node id). Opening reads GitHub's `files { path viewerViewedState }` too:
- GitHub's state wins: a file is viewed when it says `VIEWED`, and Manta's copy follows it, ticks and unticks made on github.com included;
- `DISMISSED` (GitHub saw the file change) counts as not viewed;
- a change GitHub refused is kept in Manta and marked unsynced (`unsyncedViewed` in the store), and the status bar says so. The next open keeps it over GitHub's state and sends it again; once GitHub takes it, it's synced;
- a file GitHub didn't answer for (it can't be asked, or past the first 100) keeps Manta's tick.

**The worktree must still be on the PR.** Opening, ticking viewed, posting and submitting each pass the tab's PR number, and main refuses (`reviewTargetProblem`) when the worktree has left the PR's branch or the branch now has another PR, saying which. Nothing lands on the wrong pull request.

**Nothing typed is lost:** the comment box closes only once the comment went through (posted, or kept pending). If GitHub or the store refuses it, the box stays with its text, and the error is in the status bar. The same holds for the Changes and Branch diffs' comments.

**IPC:** `openPullRequestReview` (needs the PR tab's last answer), `pullRequestCommentable`, `setPullRequestFileViewed`, `postPullRequestComment`, `submitPullRequestReview` (base and head shas from the tab, guarded as full shas), `sendReviewDraft`. Streamed: `pr:changed`.

**Tests:** `core/review/__tests__/pullRequestReview.test.ts`. A bare temp `origin` stands in for GitHub, with the PR's head at `refs/pull/7/head` made by `git update-ref`. It covers the fetch and diff, viewed fingerprints, unpushed and own PRs, posting and submitting through a stubbed `gh` (bodies checked on stdin), the stale and own-PR refusals, a refused review keeping its comments, and the viewed sync (GitHub winning, unsynced changes kept and resent), a fork's PR fetched from its own remote, and a renamed file's diff and comments. Also `pullRequestRequests.test.ts`, `github.test.ts` (`parseViewedFiles`), `git.test.ts` (`diffBlobs`, `mergeBase`), and `renderer/src/lib/__tests__/reviewAnchors.test.ts` (`placeThreads`, `inRanges`).

**Known limits:**
- With only `origin`, and that a fork, the review can't reach the parent's PR refs; the error says to add a remote for it.
- A head pushed in the minute before Manta notices it can take a review against the older commit; GitHub then shows its comments as outdated.
- GitHub's viewed state is read for the first 100 files.
- No replying to or resolving threads.
