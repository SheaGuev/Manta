# P12 part 4: PR review. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review a PR inside Manta:
- **Review files** on the PR tab opens a review tab. It lists the PR's changed files on the left, each with a viewed tick, and shows the selected file's diff on the right.
- Commenting works as in G-D. **Add single comment** posts to GitHub at once. **Start a review** and **Add review comment** hold comments in a pending review.
- **Finish review** submits the pending review as Comment, Approve or Request changes. **Send to agent…** works as in G-D.
- Existing review threads show read-only under their lines.

**Architecture:**
- **The diff:**
  - It's the PR's own: the head is fetched into `refs/manta/pr/<n>` and diffed from its merge-base with `origin/<base>`, like the Branch tab.
  - Core also returns, per file, the line ranges GitHub accepts comments on (the diff's hunks) and a fingerprint of the file's diff for the viewed state.
- **The pending review:** its comments are ordinary `ReviewComment`s in G-D's per-worktree store, with `diff: 'pr:<n>'`, so they reuse anchoring, the outdated check and persistence. Viewed state goes in the same file.
- **Posting to GitHub:** through G-E's `GhRunner`, with request bodies built by pure functions: `gh api --method POST repos/{owner}/{repo}/pulls/<n>/comments|reviews --input -`.
- **The UI:**
  - `commentGutter.ts` gains configurable box actions, a `canComment` filter, and read-only thread notes.
  - `CompareView` takes its comment wiring from its parent, so the branch diff and the PR review each bring their own.
  - The review tab is a new tab kind in `App.tsx`.
- **GitHub's viewed state** is mirrored last, through GraphQL, and can be dropped with a ruling if `gh` makes it unreliable.

**Tech Stack:** Electron, React, TypeScript, CodeMirror 6 with `@codemirror/merge` 6.12.2, the user's `gh`, vitest with real temp repos (a bare `origin` standing in for GitHub's refs).

**Spec:** [docs/superpowers/specs/2026-10-26-orca-polish-design.md](../specs/2026-10-26-orca-polish-design.md), section G-F. It builds on part 2 (G-D) and part 3 (G-E):
- `GhRunner`, `PullRequestDetail` and `PullRequests`
- the PR tab
- `ReviewCommentStore`, `deliverPrompt`, `commentGutter.ts`, `reviewAnchors.ts`, `AgentPicker` and `useDiffComments`

## Global Constraints

- [docs/patterns.md](../../patterns.md):
  - No `as` casts, including `as const` and casts in tests.
  - Guards for outside data: `gh` output, JSON files and IPC arguments.
  - Per-file stores serialise their own I/O.
  - Atomic writes.
  - `OpResult` for refusals the user should see.
  - `/** */` comments only for a why that isn't obvious.
  - Never dispatch inside a CodeMirror update.
- [src/README.md](../../../src/README.md) boundaries.
- New, renamed or removed files update their folder's README table in the same task.
- A task is done only when `npm run typecheck` and `npm test` pass.
- **Tests never reach GitHub.** `gh` goes through the injected `GhRunner`. Git fetches go to a bare temp `origin` with `refs/pull/<n>/head` made by `git update-ref`.
- **UI checks** run on the isolated build, with `MANTA_USER_DATA`, `MANTA_FAKE_AGENT=1`, and `MANTA_FAKE_GH` (part 3) pointing at a stand-in that logs `api` calls and their stdin. The worktree's `origin` is a local bare repo. Never post to real GitHub without asking.
- No live Claude Code runs.
- **Git:** work on branch `p12-part4`, cut from where part 3 lands. Stage each task's files and don't commit until the user asks.
- **UI:** minimal and clean, in Manta's style. Reuse the part 2 and part 3 classes and the CSS variables.
- Sending to an agent never switches tabs.
- **Only comments written in a PR review go to GitHub,** and only through **Add single comment** or **Finish review**. Comments on the Changes and Branch diffs stay in Manta (the spec's anti-goal).

## Review Focus

1. **A comment on a line GitHub won't accept,** such as a line outside every hunk of the PR's diff. GitHub answers 422. The **+** is offered only on lines inside a hunk, on the side the hunk covers. Pinned in Task 1 (`hunkRanges`) and Task 4 (`canComment`).
2. **The PR's head moved after pending comments were written** (the author pushed again):
   - **Finish review** refuses, names the comments that no longer match, and posts nothing. The user deletes or rewrites those.
   - The comments show as outdated in the diff.
   - Pinned in Task 2.
3. **A submit that fails** (network, 422, or losing write access): the pending comments are all kept, GitHub's message is shown, and nothing is half-posted. A review is one request. Pinned in Task 2.
4. **Your own PR:** **Finish review** offers only Comment. Core also refuses Approve and Request changes on it, with a message, in case the UI is bypassed. Pinned in Task 2, and checked by eye in Task 5.
5. **A file's diff changes after it was ticked viewed** (a new push): it reads as not viewed. Pinned in Task 2 (fingerprints).

---

### Task 1: The PR's diff (git and core)

**Files:**
- Modify: `src/core/repo/git.ts`, `src/core/repo/README.md`
- Create: `src/core/review/pullRequestReview.ts` (first part), with a row in `src/core/review/README.md`
- Test: `src/core/repo/__tests__/git.test.ts`, `src/core/review/__tests__/pullRequestReview.test.ts`

**Interfaces:**
- **Produces, in `Git`:**
  - `fetchRefspecs(remote: string, specs: readonly string[]): Promise<void>`: `git fetch --quiet <remote> <specs…>`.
  - `mergeBase(a: string, b: string): Promise<string | null>`: null for unrelated histories.
  - `diffBlobs(from: string, to: string): Promise<Map<string, string>>`: path → `<oldBlob>:<newBlob>`, from `git diff --raw -z --no-abbrev -M from to`, keyed by the new path. A deleted file is keyed by its old path.
  - `fileHunks(from: string, to: string, relPath: string): Promise<string>`: `git diff -U3 from to -- relPath`.
- **Produces, in `pullRequestReview.ts`:**
  - `type LineRange = [number, number]` (inclusive)
  - `hunkRanges(patch: string): { old: LineRange[]; new: LineRange[] }`
    - It parses `@@ -a[,b] +c[,d] @@` headers. A missing count is 1, and a count of 0 gives no range on that side.
  - `fetchPullRequestDiff(git: Git, number: number, baseRefName: string): Promise<{ base: string; head: string }>`
    1. `fetchRefspecs('origin', ['+refs/pull/<n>/head:refs/manta/pr/<n>', '+refs/heads/<base>:refs/remotes/origin/<base>'])`
    2. `head` is the resolved `refs/manta/pr/<n>`. `base` is `mergeBase(head, 'origin/<base>')`.
    - It throws `"No common history with origin/<base>"` when there is no merge-base.
    - `baseRefName` is checked with `isSafeRef`, and `number` must be a positive integer.

- [ ] **Step 1: Write the failing tests.**
  - **`git.test.ts`:**
    - `it('maps each changed path to its old and new blob')`: cover an edit, an add (old blob all zeros), a delete and a rename.
    - `it('finds a merge-base, and null for unrelated histories')`
  - **`pullRequestReview.test.ts`:**
    - `it('reads hunk ranges for both sides, including one-line and empty sides')`: use `@@ -3,7 +3,9 @@`, `@@ -10 +12 @@` and `@@ -0,0 +1,4 @@` (a new file), and check exact ranges.
    - `it("fetches a PR's head into a hidden ref and diffs it from the merge-base with its base")`:
      1. Set up a bare origin with `main`. Push a `feature` branch with two commits from a second clone, then run `git -C origin.git update-ref refs/pull/7/head <feature tip>`.
      2. In the worktree clone, which has never seen `feature`: `base` is `main`'s tip at the fork, and `head` is the feature tip.
      3. `refs/manta/pr/7` exists. `git branch -a` doesn't list it.
    - `it('refuses an unsafe base name and a non-positive number')`
- [ ] **Step 2: Run** `npx vitest run src/core/review/__tests__/pullRequestReview.test.ts src/core/repo/__tests__/git.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it, and update both READMEs.**
- [ ] **Step 4: Run** the same command, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage** `src/core`.

### Task 2: Review state and posting (core)

**Files:**
- Modify: `src/shared/ipc.ts` (`ReviewDiff`, new types), `src/core/review/reviewComments.ts` (accept `pr:<n>`, and the viewed map), `src/core/review/pullRequestReview.ts` (the `PullRequestReviews` class), `src/core/review/README.md`
- Create: `src/core/review/pullRequestRequests.ts`
- Test: `src/core/review/__tests__/pullRequestRequests.test.ts`, `src/core/review/__tests__/pullRequestReview.test.ts`, `src/core/review/__tests__/reviewComments.test.ts`

**Interfaces:**
- **Produces, in `shared/ipc.ts`:**
  - `ReviewDiff` becomes `'changes' | 'branch' | \`pr:${number}\``.
  - `isReviewDiff(value: unknown): value is ReviewDiff`: `'changes'`, `'branch'`, or a string matching `/^pr:[1-9]\d*$/`. It's a type guard, not a cast. It sits beside `Channel`, which already has runtime code, and imports nothing.
  - `PullRequestReviewFile`: `FileChange & { viewed: boolean; fingerprint: string }`.
  - `PullRequestReviewInfo { number: number; base: string; head: string; files: PullRequestReviewFile[]; unpushed: boolean; own: boolean }`
  - `ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'`
- **Produces, in `pullRequestRequests.ts`** (pure). These are the REST bodies for `POST /repos/{owner}/{repo}/pulls/{n}/comments` and `…/reviews`:
  - `singleCommentRequest(c: { commitId: string; relPath: string; side: 'old' | 'new'; line: number; body: string }): { body: string; commit_id: string; path: string; line: number; side: 'LEFT' | 'RIGHT' }`
  - `reviewRequest(r: { commitId: string; event: ReviewEvent; body: string; comments: readonly ReviewComment[] }): { commit_id; event; body; comments: { path; line; side; body }[] }`
  - `reviewProblem(r: { event: ReviewEvent; body: string; count: number; own: boolean }): string | null`. In order:
    - own PR with an event other than `COMMENT`: "You can't approve or request changes on your own PR"
    - `REQUEST_CHANGES` with an empty body: "Say what needs to change"
    - `COMMENT` with an empty body and no comments: "Write a summary or add a comment"
    - otherwise null
- **Produces, in `ReviewCommentStore`:**
  - `add` accepts `diff: 'pr:<n>'`. `parseComment` uses `isReviewDiff`.
  - `viewed(pr: number): Promise<Record<string, string>>`: path → fingerprint.
  - `setViewed(pr: number, relPath: string, fingerprint: string | null): Promise<void>`. Null removes the entry.
  - The file becomes `{ comments, prSent, viewed: { "<n>": { path: fingerprint } } }`. A malformed `viewed` reads as `{}`.
- **Produces, in `pullRequestReview.ts`:**
  - `staleComments(comments: readonly ReviewComment[], fileAt: (side: 'old' | 'new', relPath: string) => Promise<string | null>): Promise<ReviewComment[]>`. A comment is stale when the file's line `line` on its side no longer equals `lineText`.
  - `class PullRequestReviews`:
    - `constructor(options: { run: GhRunner; pullRequests: PullRequests })`
    - `open(root: string, git: Git, store: ReviewCommentStore, pr: PullRequestDetail): Promise<OpResult & { review?: PullRequestReviewInfo }>`
      - It runs `fetchPullRequestDiff` and `diffFiles(base, head)`. `viewed` is true when the stored fingerprint equals the file's current one from `diffBlobs`.
      - `unpushed` is `!(await git.isAncestor('HEAD', head))`.
      - `own` is `pr.author === pr.viewer`.
      - A fetch failure returns `{ ok: false, message: <git's stderr> }`.
    - `commentable(git: Git, base: string, head: string, relPath: string): Promise<{ old: LineRange[]; new: LineRange[] }>`
    - `postSingle(root, pr: PullRequestDetail, head: string, anchor: ReviewAnchor, body: string): Promise<OpResult>`
      - It runs `gh api --method POST repos/{owner}/{repo}/pulls/<n>/comments --input -` with `singleCommentRequest` as stdin, then forces `pullRequests.status` so the new thread shows.
      - On failure it returns `gh`'s message.
    - `submit(root, git, store, pr, review: PullRequestReviewInfo, input: { event: ReviewEvent; body: string }): Promise<OpResult>`
      1. The pending comments are the store's comments with `diff === 'pr:<n>'`.
      2. `reviewProblem` decides the first refusal.
      3. Then `staleComments` against `git.show(base | head, relPath)`. Any stale comment refuses with "N pending comments no longer match the PR (file:line, …); delete or rewrite them".
      4. Then one `POST …/reviews` with `reviewRequest`.
      5. On success: remove those comments, force a status refresh, and return `{ ok: true, message: 'Review submitted' }`. Add `(approved)` or `(changes requested)` to the message when that was the event.
      - On failure, nothing is removed.

- [ ] **Step 1: Write the failing tests.**
  - **`pullRequestRequests.test.ts`:**
    - `it('builds a single comment body with the head commit and GitHub side names')`: compare the exact objects for an old-side and a new-side comment.
    - `it('builds a review body with every pending comment')`
    - `it('refuses own-PR verdicts, empty change requests and empty comment reviews, in that order')`
  - **`reviewComments.test.ts`:**
    - `it('stores pending PR comments beside the branch ones, and rejects a malformed pr diff')`: `pr:0` and `pr:x` entries are skipped.
    - `it('keeps viewed fingerprints per PR and tolerates a file without them')`
  - **`pullRequestReview.test.ts`**, with a real temp repo from Task 1's setup and a `GhRunner` stub logging args and stdin:
    - `it('marks a file viewed only while its diff is unchanged')`:
      1. `setViewed` with the current fingerprint, then `open`: viewed.
      2. Push another commit touching the file, update `refs/pull/7/head`, and `open` again: not viewed.
    - `it('reports unpushed local commits and an own PR')`
    - `it('posts a single comment with the PR head and refreshes the PR')`: the stub saw `api --method POST repos/{owner}/{repo}/pulls/7/comments --input -`, the stdin parses to the expected object, and the next `status` was forced.
    - `it('submits one review with all pending comments and clears them')`
    - `it('refuses to submit while a pending comment no longer matches the head, and posts nothing')`
    - `it('keeps every pending comment when GitHub refuses the review')`: the stub fails with "HTTP 422: Unprocessable Entity". The result carries that message, and the store still has the comments.
    - `it('refuses Approve on your own PR even if asked directly')`
- [ ] **Step 2: Run** `npx vitest run src/core/review`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Update `main/index.ts`'s `reviewAnchor` guard to use `isReviewDiff`, so typecheck stays green. The channel work is in Task 3.
- [ ] **Step 4: Run** `npx vitest run src/core/review && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage** `src/core src/shared/ipc.ts src/main/index.ts`.

### Task 3: IPC and main

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`
- Test: none new. The behaviour is in core, and the guards follow part 2's.

**Interfaces:**
- **`MantaApi` gets:**
  - `openPullRequestReview(root: string): Promise<OpResult & { review?: PullRequestReviewInfo }>`. It uses `PullRequests.cached(root)` (part 3), and refuses "Open the PR tab first" without one. The other `pr:` handlers below read the PR the same way.
  - `pullRequestCommentable(root: string, base: string, head: string, relPath: string): Promise<{ old: [number, number][]; new: [number, number][] }>`
  - `setPullRequestFileViewed(root: string, number: number, relPath: string, fingerprint: string | null): Promise<OpResult>`. Task 6 adds the GitHub mirror behind this same call.
  - `postPullRequestComment(root: string, head: string, anchor: ReviewAnchor, body: string): Promise<OpResult>`
  - `submitPullRequestReview(root: string, input: { event: ReviewEvent; body: string }): Promise<OpResult>`
  - `sendReviewDraft(root: string, anchor: ReviewAnchor, body: string, target: ReviewTarget): Promise<OpResult>`. It sends one comment that isn't stored: `formatReviewMessage([{ ...anchor, id: '', body, createdAt: now, sent: null }], basename(root))` through `deliverPrompt`.
- **Channels:** `pr:openReview`, `pr:commentable`, `pr:setViewed`, `pr:postComment`, `pr:submitReview`, and `review:sendDraft`.
- **Guards:**
  - `base` and `head` must be 40-hex shas (reuse `sha()`).
  - `fingerprint` is `string | null`, and `event` is one of the three.
  - `reviewAnchor` already uses `isReviewDiff`.
- **Events:**
  - After `submit` and `postSingle`, send `review:changed` with the root, plus a new `pr:changed` with the root. `usePullRequest` (part 3) listens to `pr:changed` and forces a refresh.
  - `setViewed` sends nothing; the review tab updates its own state from the result.

- [ ] **Step 1: Wire the channels, the preload methods, the guards and the `pr:changed` listener in `usePullRequest`.** Run `npm run typecheck`. Expected: PASS.
- [ ] **Step 2: Run** `npm test`. Expected: PASS.
- [ ] **Step 3: Stage.**

### Task 4: The gutter for PR diffs (renderer)

**Files:**
- Modify: `src/renderer/src/lib/commentGutter.ts`, `src/renderer/src/lib/reviewAnchors.ts` (`placeThreads`, `inRanges`), `src/renderer/src/components/DiffComments.tsx`, `src/renderer/src/components/CompareView.tsx`, `src/renderer/src/App.tsx` (CompareView's new prop), `src/renderer/src/style.css`, the lib and components READMEs
- Create: `src/renderer/src/components/PullRequestComments.tsx`
- Test: `src/renderer/src/lib/__tests__/reviewAnchors.test.ts`

**Interfaces:**
- **Produces, in `reviewAnchors.ts`:**
  - `inRanges(ranges: readonly [number, number][], line: number): boolean`
  - `ThreadNote { id: string; side: 'old' | 'new'; line: number; author: string; body: string; replies: number; url: string }`
  - `placeThreads(state: EditorState, notes: readonly ThreadNote[]): { note: ThreadNote; pos: number; before: boolean }[]`
    - It maps lines to positions the same way `placeComments` does, but has no outdated check, since GitHub's line is trusted.
    - A note whose line is outside the document is dropped.
- **`commentGutter.ts` changes** (G-D's behaviour is unchanged when the new options are absent):
  - `CommentHandlers` changes:
    - `onSave(anchor, body, action: string, rect: DOMRect | null)` replaces the `send` argument.
      - `action` is a box action's id, or `'send'` for the send icon.
      - `rect` is the clicked button's rect.
    - `actions(): readonly { id: string; label: string; accent: boolean }[]`. It's read when the box is drawn. G-D returns `[{ id: 'comment', label: 'Comment', accent: true }]`.
    - `canComment?(side: 'old' | 'new', line: number): boolean`. With no `canComment`, every line can take a comment. When it returns false, there's no **+** for that line or deleted row.
  - `setThreadNotes = StateEffect.define<readonly ThreadNote[]>()`. It draws a read-only `ThreadNoteWidget` (`.cm-threadNote`) under each placed note:
    - "@author", the body (pre-wrapped), and a muted "N replies" when there are any;
    - a link icon to the thread's `url`.
    - Its `side` is between the saved comments and the drafts, so a draft box appears under the existing thread.
  - `SavedCommentWidget` shows a muted "pending" label in place of "sent to X" when `comment.diff` starts with `pr:`.
- **`DiffComments.tsx`:**
  - `useDiffComments` maps `action === 'comment'` to save, and `'send'` to save and then open the picker. That's part 2's behaviour.
  - It exports `type DiffCommentsHandle = ReturnType<typeof useDiffComments>`.
- **`CompareView`:**
  - It takes `comments: DiffCommentsHandle | null` in place of `review`.
  - The same file exports `BranchCompareView`, with the old props. It calls `useDiffComments` when `review` is true, and `App.tsx` renders it for compare tabs.
- **`PullRequestComments.tsx` exports `usePullRequestComments`:**

```ts
usePullRequestComments(o: {
  root: string
  pr: PullRequestDetail
  review: PullRequestReviewInfo
  relPath: string
  onResult: (r: OpResult) => void
  onError: (m: string) => void
}): DiffCommentsHandle
```

  - **The box actions:**
    - **Add single comment** (`single`, not accent)
    - **Start a review** (`review`, accent), or **Add review comment** once the PR has a pending comment
  - **What each action does:**
    - `single` calls `postPullRequestComment(root, review.head, anchor, body)`.
    - `review` calls `addReviewComment` with `diff: 'pr:<n>'`.
    - `send` opens `AgentPicker` and calls `sendReviewDraft`.
  - **`canComment`** comes from `pullRequestCommentable`, loaded once per file. Until it loads, it's false everywhere.
  - **Thread notes** are `pr.comments` filtered to `kind === 'thread'`, this `relPath`, not outdated, with `line` and `side` set.
  - **Pending comments** are drawn through `setReviewComments` (the store's `pr:<n>` comments for this file).

- [ ] **Step 1: Write the failing tests** in `reviewAnchors.test.ts`:
  - `it('places a new-side thread under its line and an old-side one under its deleted row')`
  - `it('drops a thread whose line is past the end of the file')`
  - `it('tells whether a line is inside any range')`
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/lib/__tests__/reviewAnchors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the anchors, then the gutter changes and the hook, and move `App.tsx` to `BranchCompareView`.** Run the tests again, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Check by eye that part 2 still works.** In a Branch diff, the + and the box with **Comment** and the send icon behave exactly as before. Take one screenshot.
- [ ] **Step 5: Stage.**

### Task 5: The review tab and Finish review (renderer)

**Files:**
- Create: `src/renderer/src/components/PullRequestReview.tsx`, `src/renderer/src/components/FinishReviewDialog.tsx`
- Modify: `src/renderer/src/App.tsx` (the `ReviewTab` kind), `src/renderer/src/components/PullRequestPanel.tsx` (the **Review files** button), `src/renderer/src/style.css`, the components README

**Interfaces:**
- **`App.tsx`:**
  - `interface ReviewTab { root: string; pullRequest: number; title: string }`. The `title` is "Review #<n>".
  - `isReviewTab` checks `'pullRequest' in tab`. `tabKey` is `review:<root>:<n>`.
  - The persisted-tab guard accepts it.
  - Reopening focuses the existing tab.
  - It renders `PullRequestReview`.
- **`PullRequestPanel`:** the header gets a **Review files** icon button (`FileSearch`, titled "Review files") when the status is `found`. It calls a new `onReviewFiles(number)` prop, threaded through `RightPanel` to `App`'s open-tab.
- **`PullRequestReview` props:** `{ root: string; pullRequest: number; onResult; onError }`.
  - It reads the PR through `usePullRequest(root, focusCount)` (part 3), then calls `openPullRequestReview(root)`. It opens again when `pr.headRefOid` changes.
  - **The layout:** a two-column grid.
    - **Left, about 260 px:**
      - a header with "N of M viewed" and **Finish review**, which carries the pending count as a `.badge`. It's always enabled, since an approval needs no comments;
      - under the header, when `unpushed` is set: the muted line "Showing the PR on GitHub; this worktree has commits it doesn't";
      - then one row per file, in the Changes tab's row style: a viewed checkbox, the file name, a muted folder, and `+a −r`.
    - **Right:** `CompareView` for the selected file (`from: review.base`, `to: review.head`; `from` is null for an added file), with `comments: usePullRequestComments(…)`.
  - **Behaviour:**
    - Clicking a row selects its file.
    - Ticking a box calls `setPullRequestFileViewed` with the file's fingerprint, or null to untick, and updates the row from the result.
    - Ticking also moves the selection to the next unviewed file, like GitHub.
    - The first file is selected on open.
- **`FinishReviewDialog` props:** `{ own: boolean; pending: number; onSubmit: (input: { event: ReviewEvent; body: string }) => Promise<OpResult>; onClose }`.
  - It's a `.dialog` with a summary textarea and three radio rows: Comment, Approve and Request changes.
  - When `own` is set, Approve and Request changes are disabled, titled "You can't approve or request changes on your own PR".
  - **Submit review** shows core's refusal or GitHub's error in `.dialog-error` and stays open. Success closes it and reports through `onResult`.

- [ ] **Step 1: Build the tab, the file list, the dialog and the button.** Run `npm run typecheck`. Expected: PASS.
- [ ] **Step 2: Check by eye** on the isolated build. The worktree's `origin` is a bare repo with `refs/pull/7/head`. `MANTA_FAKE_GH` prints a PR #7 detail whose head is that ref's sha, and logs `api` calls with their stdin.
  - **Review files** opens "Review #7": files listed, the count reads "0 of N viewed", and the first file's diff shows.
  - Hovering shows a **+** only on lines inside hunks.
  - An existing thread shows under its line.
  - **Add single comment** logs one `pulls/7/comments` call with the right body.
  - **Start a review** adds a pending comment, and the button becomes **Add review comment**.
  - Ticking viewed moves to the next file, and the count updates.
  - **Finish review**, Comment: one `pulls/7/reviews` call holding every pending comment, and the badge clears.
  - Your own PR (the fixture's `author` equals `viewer`): Approve is disabled.
  - Stand-in failure: the error shows in the dialog, and the pending comments remain.
  - Screenshot the tab and the dialog.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Stage.**

### Task 6: Mirror viewed to GitHub, and docs

**Files:**
- Modify: `src/core/repo/github.ts` (viewed state), `src/core/review/pullRequestReview.ts` (merge on `open`, mirror on `setViewed`), `src/main/index.ts` (the `pr:setViewed` handler calls the mirror), `docs/reviews.md` (a "PR review" section), `docs/roadmap.md` (G-F built), the READMEs
- Test: `src/core/repo/__tests__/github.test.ts`, `src/core/review/__tests__/pullRequestReview.test.ts`

**Interfaces:**
- **Produces, in `github.ts`:**
  - `parseViewedFiles(output: string): Map<string, 'VIEWED' | 'UNVIEWED' | 'DISMISSED'> | undefined`. It reads `data.repository.pullRequest.files.nodes[] { path, viewerViewedState }` and skips unknown states.
  - `VIEWED_QUERY`: `repository(owner:$owner,name:$name){pullRequest(number:$number){files(first:100){nodes{path viewerViewedState}}}}`
  - `MARK_VIEWED` and `UNMARK_VIEWED`: the mutations `markFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}` and `unmarkFileAsViewed(…)`.
- **`PullRequestReviews` changes:**
  - **`open`** also runs `VIEWED_QUERY`.
    - A file is viewed when Manta's fingerprint matches, or GitHub says `VIEWED`. A GitHub `VIEWED` that Manta lacks is stored with the current fingerprint.
    - `DISMISSED` means GitHub saw the file change since it was viewed, so it counts as not viewed.
    - A failed query leaves Manta's state alone.
  - **`setViewed(root, store, pr, relPath, fingerprint | null)`** writes Manta first, then runs the mutation.
    - A failed mutation returns `{ ok: true, message: "Kept as viewed in Manta; GitHub didn't take it: <gh message>" }`.
    - Manta's state stands either way.
- **The fallback:** if the user's `gh` can't run these mutations (for example, a token without the needed scope), record a ruling. The UI keeps working from Manta's state, and docs list it as a limit.

- [ ] **Step 1: Write the failing tests.**
  - **`github.test.ts`:** `it('reads viewed states and skips unknown ones')`.
  - **`pullRequestReview.test.ts`:**
    - `it('takes viewed files from GitHub that Manta did not know')`
    - `it('treats a dismissed file as not viewed')`
    - `it('marks and unmarks a file on GitHub, and keeps Manta's state when GitHub refuses')`: the stub logs the mutation and `-F path=…`, then fails once.
- [ ] **Step 2: Run** `npx vitest run src/core/repo/__tests__/github.test.ts src/core/review`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Run the same command, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Write the docs.** `docs/reviews.md` gets a "PR review" section covering:
  - the hidden ref and the merge-base diff;
  - commentable lines;
  - pending comments as `pr:<n>` review comments;
  - single comments and reviews, with their requests;
  - the stale and own-PR refusals;
  - viewed fingerprints and the GitHub mirror;
  - known limits: renames show as a whole new file, which `CompareView` diffs by one path; 100 files for the viewed mirror; no replies to threads.

  Then run `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Stage.**

---

## Self-review notes

- **Spec coverage (G-F):**
  - **Review files** opens a middle tab with the files on the left and the diff on the right.
  - Viewed ticks and the "N of M" count.
  - The + in the margin, as in G-D.
  - **Add single comment** posts immediately.
  - **Start a review** and **Add review comment** hold comments pending.
  - **Finish review** with the count, a summary, and Comment, Approve or Request changes.
  - **Send to agent…** in the box.
  - The diff is the PR's own (a hidden ref, the merge-base, an unpushed note).
  - Viewed is kept in Manta per PR and file, cleared when the diff changes, then mirrored to GitHub last, with a Manta-only fallback.
  - The pending review is held in Manta and submitted in one POST.
  - Single comments carry `commit_id`, `path`, `line` and `side`.
  - Existing threads show inline and read-only.
  - A new tab kind; `CompareView` with the gutter; the file list in the Changes rows' style.
  - Own PR: Comment only.
  - Request bodies are pure and checked against expected objects; the fetch-and-diff path runs against a real temp origin; `gh` goes through the runner.
- **Calls this plan makes that the spec doesn't** (each is a ruling for the executor to ledger if it changes):
  - **Pending comments as review comments:** they're G-D review comments with `diff: 'pr:<n>'`, rather than a separate list in the same file. That reuses anchoring, the outdated check and the store's queue. The Changes and Branch lists already filter by `diff`, so they never show them.
  - **Send to agent from the review box** sends the comment without storing it. Otherwise it would sit in the diff looking like a pending GitHub comment.
  - **Commentable lines:** the + shows only on lines inside the diff's hunks. GitHub rejects other lines, and the spec's "as in G-D" didn't account for that.
  - **A moved head:** **Finish review** refuses while a pending comment no longer matches the PR's head, instead of posting it against an old commit.
  - **The empty-body rules** (`reviewProblem`) follow GitHub's REST docs. If GitHub accepts a case they refuse, loosen them.
  - **Renames:** a renamed file diffs as a new file. `CompareView` reads one path at both commits. That's a known limit, not handled.
