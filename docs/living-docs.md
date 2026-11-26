# Living docs

How a markdown file in Manta stays a CRDT inside the app and a plain file in git, for anyone changing that layer. Built in step 1 (commit `6c7077d`); threads (step 2, `docs/threads.md`) are built on top of it. This file describes the code as it is. The decision history (the step 1 plan, design decisions D1 to D12) and the CDP dev scripts are kept outside the repo and are not published.

## What a living doc is

Each markdown file is backed by a Yjs document. Inside the app the CRDT is the source of truth; the file on disk is an export of it, and git is the record everyone else sees. Changes from outside the app (Obsidian, an IDE, a teammate's push) come back in as minimal CRDT operations rather than a whole-file replace.

Invariant everything below protects: **unchanged text keeps its CRDT identity, whatever edited the file.** That is what lets anything anchored to text (threads, landed-change highlights) survive outside edits and pulls.

The CRDT holds the file's exact bytes as plain markdown (D7), not a rich-text tree. Export is the identity function, so app → git → app round-trips byte for byte and never creates formatting-only diffs.

## Data model

```
LivingDoc (src/core/docs/livingDoc.ts), one per file that has been opened
 ├─ Y.Doc
 │   ├─ Y.Text 'md'        the markdown, exactly as on disk
 │   ├─ Y.Map  'actors'    Yjs client id → who made an outside change ('disk', 'git:<sha12>')
 │   └─ Y.Map  'threads'   thread index (step 2, see docs/threads.md)
 └─ DocMeta
     ├─ lastDisk           Snapshot: what the app last wrote to (or read from) the working tree
     ├─ syncPoint          SyncPoint: the CRDT state matching a commit's version of the file
     └─ staged             Snapshot: lastDisk at the moment the doc was staged, or null
```

A `Snapshot` is `{ text, state }`: a text plus the full Yjs state that produces it. A `SyncPoint` adds `commit`. Both are forking points: outside edits fork from `lastDisk`, pulls fork from `syncPoint`.

| Snapshot | Updated when | Used by |
|---|---|---|
| `lastDisk` | The app writes the file, absorbs an outside edit, or puts the committed text back during a pull | Recognising the app's own writes; forking point for outside edits |
| `syncPoint` | A commit from the app, a pull, or `reconcileHead` after HEAD moved outside the app | Forking point for pulls |
| `staged` | Staging the doc from the Changes tab; cleared on unstage and when it becomes the sync point | Becomes the sync point when a commit of the index holds its text |

### Where things are stored

| What | Where | Committed? |
|---|---|---|
| The markdown | `<repo>/<path>.md` | Yes, as a normal file |
| Yjs update log | `<repo>/.git/manta/docs/<encoded path>/log.bin` | No |
| `lastDisk` / `syncPoint` / `staged` states | `…/last-disk.bin`, `…/sync-point.bin`, `…/staged.bin` | No |
| Their texts and the sync point's commit | `…/meta.json` | No |

`DocStore` (`src/core/docs/docStore.ts`) owns this folder. `<encoded path>` is `encodeURIComponent(relPath)`. Living under `.git/` keeps it out of the working tree, out of commits, and out of Obsidian's view.

- `log.bin` is append-only: each update is a 4-byte big-endian length plus the update bytes. `load()` merges the log into one update (`Y.mergeUpdates`) and rewrites it, so the log is compacted on every open. A truncated tail (a crash mid-append) is dropped, not fatal.
- Every write goes through `atomicWrite` (write `.tmp`, then rename). `meta.json` is written last, and `load()` treats its absence as "no stored doc", so a half-written save reads as never saved.
- All file access for one doc runs through a per-doc promise queue (`enqueue`): appends, snapshot saves and the compaction in `load()` never interleave.

## Turning text changes into CRDT ops

`src/core/docs/textEdits.ts`:

- `computeTextEdits(before, after)` returns `retain` / `delete` / `insert` edits. It diffs by line first (diff-match-patch line mode) to find changed hunks, then by character inside each hunk that is both a delete and an insert, with semantic cleanup (D6). A whole-line replace would give every edited line new identity and detach anything anchored inside it.
- `applyTextEdits(ytext, edits)` applies them to a `Y.Text`; call it inside a transaction so they land as one update.
- `mergeTextChange(target, base, newText, actor, origin)` is the core move: fork a new `Y.Doc` from `base.state`, check its text equals `base.text`, replay `base.text → newText` as minimal ops in the fork (recording `actor` in `actors` under the fork's client id), then apply to `target` only the ops `target` lacks (`encodeStateAsUpdate(fork, encodeStateVector(target))`). Edits `target` received since `base` are concurrent and survive. Returns the fork's full state, which becomes the new snapshot.
- `changedRanges(before, after)` reports hunks as spans of `after` plus the text each replaced (used by step 2's landed-change highlights).

The fork's client id is a fresh random Yjs client, so each outside change is its own actor.

## Flows

### Open

`LivingDoc.open(relPath, ctx)`:

1. Read the file. Missing → `null`. Contains `\0` → refuse as binary.
2. **Stored doc:** apply the stored update (origin `LOAD_ORIGIN`, not re-persisted), start persisting updates, then `absorbDiskChange(disk)` to pick up anything edited while the app was closed.
3. **First open:** seed the CRDT from the file's text at HEAD when it exists there, otherwise from disk. The seed state becomes both `lastDisk` and, if HEAD has the file, the `syncPoint`. If the working tree differs from the seed (uncommitted edits made before Manta), replay it with `absorbDiskChange`. This keeps the sync point exactly equal to HEAD's version.

`Workspace.open` loads every doc that has stored state up front, so edits made while the app was closed are absorbed before anything can commit or pull over them.

### Editing in the app

```
renderer: CodeMirror ⇄ yCollab ⇄ replica Y.Doc ──pushUpdate (IPC)──▶ main: LivingDoc.ydoc
                                  ▲                                         │
                                  └──────── remoteUpdate (IPC) ◀────────────┘  (non-editor origins only)
```

- The main process holds the authoritative `Y.Doc`. The renderer (`src/renderer/src/components/Editor.tsx`) opens a replica from `openDoc`'s full state, binds it to CodeMirror with `y-codemirror.next`, and sends its own updates with `pushUpdate`. Main applies them with `RENDERER_ORIGIN` and doesn't echo them back; updates from any other origin (outside edits, pulls, thread merges) go to the renderer as `remoteUpdate`. The renderer applies remote updates with its own `'main'` origin so it doesn't send them back either.
- Every update is appended to `log.bin` as it happens (`persistUpdates`).
- Writing the file is debounced (`WRITE_DEBOUNCE_MS` = 300 ms) and runs on the workspace's serial queue. `writeToDisk` sets `lastDisk` **before** writing, so when the watcher fires for the app's own write, the disk text already equals `lastDisk.text` and nothing is absorbed.

### Outside edits

The main process watches each workspace root recursively (`fs.watch(root, { recursive: true })`), skipping `.git`, `node_modules` and build folders at any depth (`isWatchIgnored`). Watching the tree rather than single files matters: editors often save by writing a temp file and renaming it over the original, which a per-file watch stops following.

On a change to a loaded doc, `Workspace.fileChanged` reads the file on the serial queue and calls `absorbDiskChange(disk)`: if it differs from `lastDisk.text`, merge `lastDisk.text → disk` with `mergeTextChange` from `lastDisk` (actor `disk`), and the fork's state becomes the new `lastDisk`. In-app typing that happened in between is concurrent and survives; the next debounced write exports the merged text.

### Telling the panels

Every event also goes into a per-root batch, sent at most 250 ms after its first event. `Workspace.cache` (`RepoCache`) classifies the batch:

| Kind | When | Stale | Who reloads |
|---|---|---|---|
| `structure` | A `rename` event that added or removed a path, a `.gitignore` change, or an event without a path | The file list | Files tab, and Changes and the status bar |
| `content` | Any event outside `.manta/` | Git status | Changes, the status bar, thread lists, open threads that aren't merged |
| `records` | `.manta/threads/<id>.json` | Nothing in git | Thread lists and thread views |

- **Telling a save from an add:** a `rename` whose path exists and is in the last file list is an editor saving by renaming, so it counts as `content`. A path that's gone and was never listed (a temp file) adds nothing. Before the list has loaded, every `rename` counts as `structure`.
- **One status run for everyone:** git status is one `Git.statusSnapshot` (four commands: `status --branch` plus three `diff --numstat`), shared by Changes and the status bar. It waits at least 3 s after the previous run (`STATUS_MIN_GAP_MS`), so a session saving file after file costs one run every 3 s.
- **File list:** reloaded at most once a second.
- **Not watched:**
  - The Branch tab and the sidebar's worktree list ignore file events. They reload when the window regains focus, and after Manta's own git operations.
  - Commits and staging made in a terminal touch only `.git`, so main marks status stale when the window regains focus.
- **Manta's own git operations** (commit, stage, pull, approve, discard) clear both caches without the gap.

`MANTA_GIT_TRACE=1` logs every git command Manta runs.

### Commit

`Workspace.commit(message)` on the serial queue:

1. `flushWrites()`: cancel pending debounced writes; for every loaded doc, absorb whatever is on disk now (an outside edit the watcher hasn't delivered yet), then write pending in-app edits. Afterwards disk, `lastDisk` and the CRDT agree for every doc.
2. Export thread records (step 2).
3. `git add -A` and commit; nothing to commit is reported, not an error.
4. `markCommitted(sha)` on every loaded doc: the sync point becomes `{ commit: sha, ...lastDisk }`, which is correct because step 1 made disk equal `lastDisk`.

Step 1 of this is why the absorb in `flushWrites` exists: without it, a commit could record a sync point whose text doesn't match the committed blob.

### Stage, unstage, discard, commit staged

The Changes tab stages per file, so a commit can hold some docs and not others, and a doc can be staged and then edited further. All on the serial queue, after `flushWrites()`:

- **`stage(paths)`** exports thread records (locally; `.manta/` never reaches git), `git add -A`s the paths, and calls `markStaged()` on those docs: `staged = lastDisk`. Because it's taken from the live doc's history, the staged state is an ancestor of every later state, so it is safe to fork from.
- **`unstage(paths)`** `git restore --staged`s the paths and clears `staged`.
- **`discardChanges(paths, confirm)`** asks first (main shows a native dialog), then `git restore --worktree`s tracked files back to the index and `git clean`s untracked ones. Loaded docs `absorbDiskChange` the restored text straight away, so the editor follows; threads anchored to text that's gone show as detached. Flushing first matters: a pending debounced write would otherwise put the discarded text back.
- **`commit(message, 'staged')`** commits the index when something is staged (otherwise it falls back to committing everything, like VS Code's smart commit), then calls `reconcileHead(sha)` on every loaded doc. Unstaged docs match their old sync point's text; staged docs match `lastDisk` or, when edited after staging, their `staged` snapshot.

### Branch tab (read-only)

The Branch tab shows in code worktrees, not the docs repo. It only reads git and never touches the CRDT. `Workspace.branch(chosen)` returns:

- **Base** (`Git.branchBase`): `merge-base HEAD <target>`, where the target is `origin/HEAD`'s branch, else the main worktree's branch, else `main` / `master`. On that branch itself it compares with the upstream instead (unpushed commits), and with no upstream there is nothing to compare with. `defaultBranch()` isn't used: it falls back to the current branch, which in a worktree is the worktree's own. The tab's picker (`BranchPicker`, listing `Git.branches()`) can choose another branch instead, kept per worktree in `localStorage`; one that no longer resolves falls back to the default and comes back as `missingBase`, which the tab notes.
- **Files**: `diff --name-status` + `--numstat` from the base to HEAD, `.manta/` left out like everywhere else.
- **Commits**: the newest 100 on HEAD, those after the base marked `onBranch`. A commit's files (`commitFiles`) are against its first parent, the first commit against the empty tree.

Rows open a `compare` tab (`CompareView`): a read-only `unifiedMergeView` of the file at two shas. Main only accepts full 40-character shas for these calls. The one ref name from the renderer is the chosen base, which `isSafeRef` checks before git sees it (no leading `-`, no `..`, no whitespace or control characters). The tab refreshes on window focus (commits made in a terminal) and when files change.

### Pull

`Workspace.pull()` on the serial queue, fast-forward only:

1. `flushWrites()`, then `git fetch`. No upstream, already up to date, or local ahead → report and stop. **Diverged history is refused.**
2. For each loaded doc that changed between HEAD and upstream: `reconcileHead(head)` must succeed (see below), and the file must still exist upstream (deletion upstream is refused).
3. Write each affected doc's **sync-point text** back to disk, so git sees those files as unmodified and can fast-forward over them. In-app edits stay in the CRDT. `lastDisk` is set to the sync point, so the watcher ignores this write.
4. `git merge --ff-only <upstream>`. On failure, write the live text back and report the git error; the CRDT hasn't changed, so nothing is half-applied.
5. For each affected doc: `mergeUpstream(target, upstreamText)` forks from the sync point, replays `syncPoint.text → upstreamText` as ops (actor `git:<sha12>`), merges into the live doc, and the fork state becomes the new sync point. Then `writeToDisk()` exports the merged text; the working tree now shows only the unpushed in-app edits as modifications.
6. `reconcileHead(target)` for the unaffected docs, then adopt any thread records that arrived.

Order matters: git moves first, the CRDT second, so a failed fast-forward never leaves the CRDT ahead of HEAD (which would make the next pull replay the same upstream change twice).

### HEAD moved outside the app

A terminal commit or pull moves HEAD without telling Manta. `reconcileHead(head)` re-aligns the sync point when it safely can:

- HEAD's version equals the old sync point's text → the file didn't change in those commits; just update the commit id.
- HEAD's version equals `lastDisk.text` → the commit captured exactly what's on disk; the sync point becomes `lastDisk`.
- HEAD's version equals `staged.text` → the commit captured what was staged, and the doc was edited since; the sync point becomes the staged snapshot.
- Anything else → no CRDT state is known to match HEAD's text; `reconcileHead` returns false and pull asks the user to commit that doc from Manta first.

## Concurrency

- **Workspace serial queue** (`Workspace.serial`): opening docs, debounced writes, absorbing outside edits, commit and pull all queue behind each other, so a debounced write can never land in the middle of a pull. Editor updates are applied directly (they only touch the in-memory CRDT and the log).
- **DocStore per-doc queue**: file-level ordering for one doc's storage, independent of the workspace queue.
- **Transaction origins**: `LOAD_ORIGIN` (stored state, not re-persisted), `RENDERER_ORIGIN` (from the editor, not echoed), `EXTERNAL_ORIGIN` (outside edits and pulls, forwarded to the editor).

## Testing

- `src/core/docs/__tests__/textEdits.test.ts`: round-trips (empty, deletion, CRLF, missing trailing newline), unchanged characters on an edited line keep identity, an anchor inside an edited line stays attached, `changedRanges`.
- `src/core/__tests__/workspace.test.ts` (real temp git repos with a bare origin and two clones): seeding from HEAD plus uncommitted edits, editor edits reaching disk, outside edit absorbed alongside in-app edits with anchors intact, committing an undelivered outside edit with a matching sync point, pulling an upstream change onto unpushed in-app edits with anchors intact, reopen restoring state and absorbing edits made while closed, doc creation path checks, diverged pull refused.
- `src/core/repo/__tests__/git.test.ts`: numstat parsing, line counting, diff stats, worktrees and per-file changes.
- UI end to end: `e2e.mjs` in the dev-scripts folder (open a doc from the tree, rendered preview, click-to-type reaching disk, outside edit appearing live, status bar counts, commit from the Changes tab, no renderer errors). Run it against an isolated instance; see "Developing" in `docs/threads.md`. Never test against the real vault.

The original proof that this approach keeps anchors through a pull was a standalone Yjs + diff-match-patch script (`/tmp/crdt-pull/proof.mjs`, not kept); the pull test in `workspace.test.ts` covers the same scenario.

## Known limits

- Pull fast-forwards only; diverged history is refused.
- A file deleted upstream, or deleted or renamed outside the app, isn't handled: pull refuses an upstream deletion, a doc whose file is missing isn't loaded, and a rename is seen as a new doc (its CRDT history and anchors don't follow).
- A block moved in an outside edit is a delete plus an insert, so anything anchored inside it detaches.
- An anchor endpoint on a character that an outside edit replaced moves to the replacement (e.g. a replaced `.` becomes `,`); anchors on unchanged text are exact.
- Every write stores a full CRDT snapshot (`lastDisk`); fine for docs, not for very large files.
- CRDT state lives only in `.git/manta/`: a fresh clone starts each doc's history from HEAD. Thread records in `.manta/threads/` (local, kept out of git) re-anchor by quoted text (see `docs/threads.md`).
- Line-ending conversion (`core.autocrlf`, `.gitattributes`) isn't applied: the committed blob is assumed to equal the working-tree text.
