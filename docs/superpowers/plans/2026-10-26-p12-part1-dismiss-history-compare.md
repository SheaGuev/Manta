# P12 part 1: dismiss suggestions, back and forward, compare branch. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship P12's first three features: dismissible context-map suggestions (G-A), one back and forward history across the whole app (G-B), and a picker for the branch the Branch tab compares against (G-C).

**Architecture:** G-A adds a dismissed-folders list to `.manta/maps/dismissed.json` that `suggestMaps` filters on, with IPC and a right-click menu in the sidebar. G-B replaces each tab set's Back history with one window-wide history of places (a context plus its active tab), kept as pure functions in `renderer/src/lib/navHistory.ts` and driven from `App.tsx` and a new Go menu. G-C lets `Workspace.branch` take an optional base ref, adds a branch list, and puts a picker at the top of the Branch tab whose choice is kept per worktree in `localStorage`.

**Tech Stack:** Electron, React, TypeScript, vitest with real temp git repos, CodeMirror 6, lucide-react icons.

**Spec:** [docs/superpowers/specs/2026-10-26-orca-polish-design.md](../specs/2026-10-26-orca-polish-design.md), sections G-A, G-B, G-C. G-D (diff comments to agents), G-E (PR tab) and G-F (PR review) get their own plans once this lands. G-D starts with a spike on commenting deleted lines in `@codemirror/merge`.

## Global Constraints

- Follow [docs/patterns.md](../../patterns.md): no `as` casts (including `as const`), guards for outside data, the serial queue for stored state, atomic writes, `OpResult` for user-facing refusals, `/** */` comments only for a non-obvious why.
- Respect [src/README.md](../../../src/README.md) boundaries: the renderer reaches main only through `window.manta`, `shared/` imports nothing, `core/` never imports Electron.
- Main validates every IPC argument (`str` and friends in `src/main/index.ts`).
- Tests go in `__tests__/` beside the code, named `<file>.test.ts`. Adding or renaming a file means updating its folder's `README.md` table in the same task (`src/__tests__/directoryReadmes.test.ts` enforces it).
- Before calling a task done: `npm run typecheck` and `npm test` pass.
- UI checks run on an isolated instance (`MANTA_USER_DATA=/tmp/manta-p12 MANTA_FAKE_AGENT=1 npm run dev`), never the user's real profile, with a screenshot looked at by eye.
- The user's git rule: **never commit without being asked.** End each task by staging its files (`git add …`) and showing what's staged. Work on a branch, not `main`.
- Minimal, clean UI in Manta's existing style: reuse `.row`, `.icon-button`, `.popover`, `.badge`, `.context-menu` and the `--bg-*` / `--text-*` variables. No new borders or colours where an existing class does.

## Review Focus

1. **A corrupt or hand-edited `dismissed.json`:** suggestions still load (it reads as empty), and the next dismissal rewrites it cleanly. Pinned in Task 1.
2. **Back into a place that's gone** (a removed worktree, a deleted map, a closed terminal): it's skipped, never crashes or opens an empty context. Pinned in Task 3 (`step` skips unusable entries, `prune`) and Task 4 (removing a worktree prunes it).
3. **A history-driven switch must not record itself** and wipe Forward. Pinned in Task 3 ("recording the entry `step` landed on changes nothing").
4. **A chosen compare branch that was deleted:** the tab falls back to the default and says which branch went missing. Pinned in Task 5.
5. **A base ref from the renderer starting with `-`** (read by git as an option): refused in core before git runs. Pinned in Task 5.

---

### Task 1: Dismissed suggestions in core (G-A)

**Files:**
- Modify: `src/core/maps/mapSuggestions.ts` (`suggestMaps`)
- Modify: `src/core/maps/mapStore.ts` (dismissed list)
- Modify: `src/core/workspaceMaps.ts` (`suggest`, two new methods)
- Modify: `src/core/maps/README.md` (rows for `mapSuggestions.ts` and `mapStore.ts`)
- Test: `src/core/maps/__tests__/mapSuggestions.test.ts`, `src/core/__tests__/workspaceMaps.test.ts`

**Interfaces:**
- Produces: `suggestMaps({ docs, threadDocs, mappedDocs, dismissed }: { docs: readonly string[]; threadDocs: readonly string[]; mappedDocs: readonly string[]; dismissed: readonly string[] }): MapSuggestion[]`
- Produces: `MapStore.dismissed(): Promise<string[]>` and `MapStore.writeDismissed(folders: readonly string[]): Promise<boolean>`. The file is `.manta/maps/dismissed.json`: a sorted, de-duplicated JSON array of folder paths, `JSON.stringify(list, null, 2) + '\n'`, written through the existing `writeIfChanged`. Anything that isn't an array of strings reads as `[]`. `MapStore.list()` already skips names that don't match `MAP_ID`, so the file never reads as a map.
- Produces: `WorkspaceMaps.dismissedSuggestions(): Promise<string[]>` and `WorkspaceMaps.setSuggestionDismissed(folder: string, dismissed: boolean): Promise<string[]>`. The second runs inside `this.access.serial` and returns the new list. A `folder` that is empty, absolute, or has a `..` segment throws (a programmer error, since the UI only sends folders it was given).

- [ ] **Step 1: Write the failing tests**

In `mapSuggestions.test.ts`, pass `dismissed: []` to every existing call and add:

```ts
it('skips dismissed folders and lets the next one move up', () => {
  const many = ['a', 'b', 'c', 'd'].flatMap((folder) => [`${folder}/1.md`, `${folder}/2.md`])
  expect(suggestMaps({ docs: many, threadDocs: [], mappedDocs: [], dismissed: ['a'] }).map((s) => s.folder)).toEqual(['b', 'c', 'd'])
})
```

In `workspaceMaps.test.ts`, beside "suggests folders no map covers yet":

```ts
it('dismisses a suggestion, keeps it dismissed, and restores it', async () => {
  const s = await setup()
  expect(await s.ws.maps.setSuggestionDismissed('docs', true)).toEqual(['docs'])
  expect(await s.ws.maps.suggest()).toEqual([])
  expect(JSON.parse(await readFile(path.join(s.docs, '.manta', 'maps', 'dismissed.json'), 'utf8'))).toEqual(['docs'])
  expect(await s.ws.maps.list()).toEqual([])
  expect(await s.ws.maps.setSuggestionDismissed('docs', false)).toEqual([])
  expect((await s.ws.maps.suggest()).map((m) => m.folder)).toEqual(['docs'])
})

it('reads a corrupt dismissed list as empty and rewrites it on the next dismissal', async () => {
  const s = await setup()
  await mkdir(path.join(s.docs, '.manta', 'maps'), { recursive: true })
  await writeFile(path.join(s.docs, '.manta', 'maps', 'dismissed.json'), '{not json')
  expect(await s.ws.maps.dismissedSuggestions()).toEqual([])
  expect((await s.ws.maps.suggest()).map((m) => m.folder)).toEqual(['docs'])
  expect(await s.ws.maps.setSuggestionDismissed('docs', true)).toEqual(['docs'])
})

it('refuses folders outside the docs repo', async () => {
  const s = await setup()
  await expect(s.ws.maps.setSuggestionDismissed('../x', true)).rejects.toThrow()
  await expect(s.ws.maps.setSuggestionDismissed('/abs', true)).rejects.toThrow()
})
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run src/core/maps/__tests__/mapSuggestions.test.ts src/core/__tests__/workspaceMaps.test.ts`
Expected: FAIL. The new tests fail on the missing `dismissed` filtering and on `setSuggestionDismissed` not being a function.

- [ ] **Step 3: Implement**

- `suggestMaps`: drop folders in `dismissed` before ranking and slicing to `MAX_SUGGESTIONS`.
- `MapStore`: add `dismissed` and `writeDismissed`, with a guard `parseDismissed(value: unknown): string[]`.
- `WorkspaceMaps.suggest` passes `await this.store.dismissed()`. Add the two methods.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx vitest run src/core/maps/__tests__/mapSuggestions.test.ts src/core/__tests__/workspaceMaps.test.ts`
Expected: PASS

- [ ] **Step 5: Update `src/core/maps/README.md`** (`mapSuggestions.ts`: "…skipping dismissed folders"; `mapStore.ts`: "…and the dismissed suggestions, `.manta/maps/dismissed.json`"). Then run `npm run typecheck && npm test`. Expected: both pass.

- [ ] **Step 6: Stage** `git add src/core/maps src/core/workspaceMaps.ts src/core/__tests__/workspaceMaps.test.ts`

### Task 2: Dismiss and restore in the sidebar (G-A)

**Files:**
- Modify: `src/shared/ipc.ts` (`MantaApi`, `Channel`)
- Modify: `src/preload/index.ts`, `src/main/index.ts` (handlers beside `Channel.suggestMaps`, line ~723)
- Modify: `src/renderer/src/lib/hooks.ts` (`useMapSuggestions`, new `useDismissedSuggestions`)
- Modify: `src/renderer/src/components/Sidebar.tsx` (suggestion rows, **New context map** row)
- Modify: `src/renderer/src/App.tsx` (state and props)
- Modify: `src/renderer/src/style.css` (the hover ×)
- Modify: `src/renderer/src/lib/README.md`, `src/renderer/src/components/README.md` (Sidebar row), `docs/context-maps.md` (suggestions), `docs/roadmap.md` (mark the P12 bullet built)

**Interfaces:**
- Consumes: `WorkspaceMaps.dismissedSuggestions()` and `setSuggestionDismissed(folder, dismissed)` from Task 1.
- Produces: `MantaApi.dismissedSuggestions(docsRoot: string): Promise<string[]>` on `Channel.dismissedSuggestions = 'map:dismissed-suggestions'`, and `MantaApi.setSuggestionDismissed(docsRoot: string, folder: string, dismissed: boolean): Promise<string[]>` on `Channel.setSuggestionDismissed = 'map:set-suggestion-dismissed'`. Main checks `folder` with `str` and `dismissed` as a boolean.
- Produces: `useMapSuggestions(docsRoot: string | null, maps: MapSummary[] | null, version: number): MapSuggestion[]`, where `version` is joined into its existing `key`, and `useDismissedSuggestions(docsRoot: string | null, version: number): string[]` (`useRootData`, `refreshOn: never`).
- New `SidebarProps`: `dismissedSuggestions: string[]`, `onSetSuggestionDismissed: (folder: string, dismissed: boolean) => void`.

- [ ] **Step 1: Add the IPC.** Channels, `MantaApi` methods, preload bridges, and main handlers through `docsMaps(docsRoot)`.

- [ ] **Step 2: Add the hooks.** Then in `App.tsx`, add `const [suggestionsVersion, setSuggestionsVersion] = useState(0)`. `onSetSuggestionDismissed` calls the API inside `run` and bumps the version, so suggestions and the dismissed list reload together.

- [ ] **Step 3: Update the sidebar.**
  - Each suggestion row gets a trailing `.icon-button` with lucide `X` (`title="Dismiss suggestion"`), shown only on row hover through CSS. Its click calls `stopPropagation()`, then dismisses.
  - Right-clicking a suggestion row opens `ContextMenu` with **Dismiss**, then one **Restore <folder>/** item per dismissed folder (lucide `RotateCcw`).
  - Right-clicking the **New context map** row opens the same menu without **Dismiss**, so a folder can be restored when no suggestions show.
  - `ContextMenu` keys items by `label`, so keep labels unique.

- [ ] **Step 4: Check it by eye.** Run `npm run typecheck && npm test`, then launch the isolated instance against a docs repo with two folders of two or more docs each. Dismiss with the ×: the row goes, and the next suggestion appears if there is one. Relaunch: it stays dismissed. Restore from the right-click menu: it comes back. Take a screenshot and look at the hover ×.

- [ ] **Step 5: Update the docs.**
  - `docs/context-maps.md`: one sentence where suggestions are described.
  - `docs/roadmap.md`: mark the P12 bullet "Dismiss map suggestions" as built.
  - The README rows listed above.

- [ ] **Step 6: Stage** the files above.

### Task 3: Window-wide navigation history, pure (G-B)

**Files:**
- Create: `src/renderer/src/lib/navHistory.ts`
- Test: `src/renderer/src/lib/__tests__/navHistory.test.ts`
- Modify: `src/renderer/src/lib/README.md` (new row)

**Interfaces:**
- Produces, generic so the module doesn't need `App.tsx`'s types:

```ts
export interface NavHistory<T> { readonly entries: readonly T[]; readonly index: number }
export function emptyHistory<T>(): NavHistory<T>                       // { entries: [], index: -1 }
export function recordVisit<T>(history: NavHistory<T>, entry: T, same: (a: T, b: T) => boolean, max?: number): NavHistory<T>
export function step<T>(history: NavHistory<T>, direction: 'back' | 'forward', usable: (entry: T) => boolean): { history: NavHistory<T>; entry: T } | null
export function canStep<T>(history: NavHistory<T>, direction: 'back' | 'forward', usable: (entry: T) => boolean): boolean
export function prune<T>(history: NavHistory<T>, keep: (entry: T) => boolean): NavHistory<T>
```

- Rules:
  - `max` defaults to 50.
  - `recordVisit` returns the same object when `entry` is `same` as `entries[index]`. Otherwise it drops the entries after `index`, appends, trims the oldest beyond `max`, and points `index` at the new last entry.
  - `step` walks from `index` in the given direction to the first `usable` entry and returns it with `index` moved there, or null.
  - `prune` removes entries, keeps `index` on the same entry when it survives (else the nearest earlier survivor, else -1), and collapses neighbours that became `same`. Callers pass `same` through a closure, or `prune` takes it as a third parameter, at the implementer's choice, as long as the tests below hold.

- [ ] **Step 1: Write the failing tests** (`T = string`, `same = (a, b) => a === b`)

```ts
it('records visits in order and ignores a repeat of the current one')
  // record a, b, b → entries ['a','b'], index 1; the third call returns the same object
it('drops forward entries when a new place is visited after going back')
  // a, b, c; step back → b; record d → entries ['a','b','d'], index 2
it('keeps at most max entries, dropping the oldest')
  // record 0..59 with max 50 → entries.length 50, entries[0] === '10', index 49
it('steps back and forward, skipping places that are gone')
  // a, b, c, d; usable = e => e !== 'c'; back from d → b; forward from b → d
it('returns null with nowhere to go, and canStep agrees')
  // empty → step back null; single 'a' → canStep back false, forward false
it('recording the entry step landed on changes nothing, so Forward survives')
  // a, b, c; back → b; recordVisit(history, 'b') returns the same history; canStep forward true
it('prunes removed places and keeps the index on the current one')
  // a, w, b, w, c at index 4; prune(keep: e => e !== 'w') → entries ['a','b','c'], index 2
  // a, b at index 1, prune b → entries ['a'], index 0
```

Write each as a full `it` with `expect(...).toEqual(...)` on `entries` and `index`. The comments above give the exact values.

- [ ] **Step 2: Run and check that they fail.** Run: `npx vitest run src/renderer/src/lib/__tests__/navHistory.test.ts`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `navHistory.ts`.** Pure, with no imports.

- [ ] **Step 4: Run and check that they pass.** The same command. Expected: PASS.

- [ ] **Step 5: Add the README row and stage.** `git add src/renderer/src/lib/navHistory.ts src/renderer/src/lib/__tests__/navHistory.test.ts src/renderer/src/lib/README.md`

### Task 4: Back and forward in the app (G-B)

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/main/index.ts` (`appMenu`, line ~257)
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts` (beside `onCloseTab`)
- Modify: `src/renderer/src/components/README.md` if a component changes, `docs/roadmap.md` (mark built)

**Interfaces:**
- Consumes: Task 3's `NavHistory`, `emptyHistory`, `recordVisit`, `step`, `canStep`, `prune`.
- Produces: `Channel.navigate = 'menu:navigate'` and `MantaApi.onNavigate(listener: (direction: 'back' | 'forward') => void): () => void`. The preload passes the direction through only when it is `'back'` or `'forward'`.
- In `App.tsx`: `interface Place { context: WorkContext; tab: Tab | null }`, with `samePlace(a, b)` comparing `contextKey(context)` and `tabKey(tab)` (null when there's no tab).

- [ ] **Step 1: Remove the per-tab-set history.**
  - `TabSet` loses `history`. It becomes `Tabs`: keep the name as a type alias so call sites don't churn.
  - Delete `MAX_HISTORY`, `canGoBack`, `goBack`, and every `history:` field (in `readTabSet`, `openTab`, `removeTab` and the terminal-prune effect).
  - `openTab` keeps focusing or adding the tab.
  - Run `npm run typecheck` and expect it to pass.

- [ ] **Step 2: Record places.**
  - Add `const [nav, setNav] = useState(emptyHistory<Place>)`.
  - Add an effect on `[here, view.active]`: when `context` is set, `setNav((h) => recordVisit(h, { context, tab: activeTab }, samePlace))`.
  - No "navigating" flag is needed. After `step`, the entry at `index` is the place being applied, so recording it is a no-op (Task 3's test pins this).

- [ ] **Step 3: Go back and forward.**
  - `usable(place)`, all of which must hold:
    - The context passes the checks `App.tsx` already uses. A map context's map is in `maps`. Any other context's root is a project root, or it's a worktree and a code project exists.
    - When `place.tab` is a terminal tab, its terminal is in `terminals`.
  - `navigate(direction)`: `step(nav, direction, usable)`. On a result, `setNav(result.history)`, `setContext(result.entry.context)`, and when it has a tab, `updateTabs(contextKey(context), …)` makes it active, re-adding it if it was closed (as the old `goBack` did).
  - The header's single Back button (`title="Back"`, around line 754) becomes two `.icon-button`s, lucide `ArrowLeft` and `ArrowRight`, with titles "Back (⌘[)" and "Forward (⌘])". Each is disabled when `!canStep(nav, …, usable)`.

- [ ] **Step 4: Prune removed places.**
  - In `onRemoveWorktree`'s success path, `setNav((h) => prune(h, (p) => p.context.root !== worktree.path))`.
  - In `mapRemoved(id)`, prune places whose `context.map === id`.
  - In `onRemoveProject`, prune places whose `context.root` starts with the project's root.

- [ ] **Step 5: Add the menu, shortcuts and mouse buttons.**
  - In `appMenu()`, after Edit, add `{ label: 'Go', submenu: [{ label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send(Channel.navigate, 'back') }, { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send(Channel.navigate, 'forward') }] }`.
  - In `App.tsx`, `useEffect(() => api.onNavigate((d) => navigateRef.current(d)), [])`, read through a ref like `closeActiveTab`.
  - Add a window `mouseup` listener: `button === 3` goes back and `button === 4` goes forward, each with `preventDefault()`.
  - The menu accelerator takes ⌘[ and ⌘] before CodeMirror's indent and outdent, by design (spec G-B). Tab and Shift+Tab still indent.

- [ ] **Step 6: Check it by eye.** Run `npm run typecheck && npm test`. On the isolated instance with two worktrees and the docs repo:
  - Open a file in worktree A, switch to worktree B and open a terminal, then switch to the docs repo.
  - ⌘[ twice returns to B's terminal, then to A's file. ⌘] goes forward again.
  - Close A's file tab, then go back to it: it reopens.
  - Remove worktree B: back skips it.
  - The mouse's side buttons do the same.
  - Take a screenshot of the header arrows.

- [ ] **Step 7: Mark the roadmap bullet built and stage.** `git add src/renderer/src/App.tsx src/main/index.ts src/shared/ipc.ts src/preload/index.ts docs/roadmap.md`

### Task 5: Compare against any branch, core (G-C)

**Files:**
- Modify: `src/core/repo/git.ts` (`branchBase`, new `branches`, new `isSafeRef`)
- Modify: `src/core/workspace.ts` (`branch`, new `branches`)
- Modify: `src/shared/ipc.ts` (`BranchSummary.missingBase`)
- Modify: `src/core/repo/README.md` (the `git.ts` row) if it lists methods
- Test: `src/core/repo/__tests__/git.test.ts`, `src/core/__tests__/workspace.test.ts`

**Interfaces:**
- Produces: `Git.branchBase(compareWith?: string | null): Promise<{ sha: string; label: string } | null>`. With `compareWith`, it's the merge-base of HEAD and that ref, labelled with the ref. Null when the ref doesn't resolve or the histories are unrelated. Without it, behaviour is unchanged.
- Produces: `Git.branches(): Promise<string[]>`: `for-each-ref --sort=-committerdate --format=%(refname) refs/heads refs/remotes`. It strips `refs/heads/`, turns `refs/remotes/<r>/<b>` into `<r>/<b>`, and drops `refs/remotes/*/HEAD`. Most recent first.
- Produces: `isSafeRef(ref: string): boolean`, exported from `git.ts`: false for empty strings, refs starting with `-`, and refs containing whitespace, `..` or a control character.
- Produces: `Workspace.branch(base: string | null = null): Promise<BranchSummary>` and `Workspace.branches(): Promise<string[]>`. An unsafe `base` throws. A safe `base` that doesn't resolve falls back to the default and sets `missingBase: base`.
- Produces: `BranchSummary.missingBase: string | null`.

- [ ] **Step 1: Write the failing tests.** In `git.test.ts`, reusing its `repo()` helper:

```ts
it('compares with a chosen branch through their merge-base', async () => {
  // base commit on main; branch 'other' off it with one commit; switch to 'feature' off base with one commit
  // expect(await new Git(dir).branchBase('other')).toEqual({ sha: base, label: 'other' })
  // expect(await new Git(dir).branchBase('missing')).toBeNull()
})
it('lists local then remote branches, most recent first, without remote HEADs', async () => {
  // main, then 'older' and 'newer' committed in that order with distinct dates (GIT_COMMITTER_DATE)
  // add a bare remote, push main, `git remote set-head origin main`
  // expect(await new Git(dir).branches()).toEqual(['newer', 'older', 'main', 'origin/main'])
})
it('refuses refs git would read as options or ranges', () => {
  for (const ref of ['', '-x', '--output=f', 'a..b', 'a b', 'a\tb']) expect(isSafeRef(ref)).toBe(false)
  for (const ref of ['main', 'origin/main', 'feature/x-1', 'v1.2']) expect(isSafeRef(ref)).toBe(true)
})
```

The `branches` expectation orders by committer date across local and remote refs. The test controls the dates so that `newer` > `older` > `main` = `origin/main`. Ties keep git's refname order: `refs/heads/main` sorts before `refs/remotes/origin/main`.

In `workspace.test.ts`:

```ts
it('falls back to the default base when the chosen one is gone, and says so', async () => {
  // a repo with a worktree branch as in git.test's worktree case
  // expect((await ws.branch('gone')).missingBase).toBe('gone'); its base equals (await ws.branch()).base
  // await expect(ws.branch('-x')).rejects.toThrow()
})
```

Fill in the setup with the file's own `setup` helper. The assertions are the ones in the comments.

- [ ] **Step 2: Run and check that they fail.** Run: `npx vitest run src/core/repo/__tests__/git.test.ts src/core/__tests__/workspace.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `NO_BRANCH` in `renderer/src/lib/hooks.ts` gets `missingBase: null` so typecheck passes.

- [ ] **Step 4: Run and check that they pass.** The same command, then `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Stage** the files above.

### Task 6: The compare branch picker (G-C)

**Files:**
- Modify: `src/shared/ipc.ts` (`branch(root, base)`, new `branches`, `Channel.branches = 'repo:branches'`)
- Modify: `src/preload/index.ts`, `src/main/index.ts` (line ~550: `base` is `null` or `str(base, 'base')`)
- Modify: `src/renderer/src/lib/hooks.ts` (`useBranch`, new `usePersistentString`)
- Create: `src/renderer/src/components/BranchPicker.tsx`
- Modify: `src/renderer/src/components/BranchPanel.tsx`, `src/renderer/src/components/RightPanel.tsx`, `src/renderer/src/style.css`
- Modify: `src/renderer/src/components/README.md` (new `BranchPicker.tsx` row, updated `BranchPanel.tsx` row), `src/renderer/src/lib/README.md` (hooks list), `docs/roadmap.md` (mark built)

**Interfaces:**
- Consumes: `Workspace.branch(base)`, `Workspace.branches()` and `BranchSummary.missingBase` from Task 5.
- Produces:
  - `MantaApi.branch(root: string, base: string | null): Promise<BranchSummary>`
  - `MantaApi.branches(root: string): Promise<string[]>`
  - `useBranch(root: string | null, base: string | null, version?: number): BranchSummary`. Its load is `(r) => api.branch(r, base)`, and `version` becomes `` `${version}:${base ?? ''}` `` so a new choice reloads.
  - `usePersistentString(storageKey: string): [string | null, (value: string | null) => void]`, backed by `localStorage` with try/catch like `usePersistentSet`. Null removes the key.
  - `BranchPicker({ root, current, defaultLabel, onChoose }: { root: string; current: string | null; defaultLabel: string | null; onChoose: (base: string | null) => void })`

- [ ] **Step 1: Wire the IPC and hooks.** In `RightPanel`: `const [base, setBase] = usePersistentString(`manta.branch-base:${root}`)`, pass `base` to `useBranch`, and pass `base` and `setBase` to `BranchPanel`. The choice lives in `localStorage` per worktree path: the renderer's per-machine store, as for the panel's other per-root state. This replaces the spec's `<userData>` file, which is the same place in practice.

- [ ] **Step 2: Build `BranchPicker`.**
  - A trigger shows `vs <label> ▾`. The label is the summary's `base.label`, and when `head` exists without a base it shows "vs nothing".
  - Clicking opens a `.popover` under the trigger with a text input and a list.
  - The first row is **Default** (resets to `null`), followed by `api.branches(root)` loaded on open.
  - The list is filtered with `fuzzyMatch` from `lib/search.ts`. With an empty query it keeps recency order; otherwise it sorts by score.
  - ↑/↓ move the selection, Enter picks it, and Escape or a click outside closes.
  - The current choice shows a check.

- [ ] **Step 3: Put it in `BranchPanel`.**
  - The picker sits as the first row of the panel whenever `head` exists, so a base can be picked even on the default branch.
  - The section's `detail` text (`vs ${base.label}`) goes, because the picker row says it.
  - When `branch.missingBase` is set, a muted row under the picker reads `<missingBase> no longer exists; comparing with <base.label>`.
  - `onOpenCompare` already takes `base.sha`, so diffs follow the choice.

- [ ] **Step 4: Check it by eye.** Run `npm run typecheck && npm test`. On the isolated instance, in a worktree:
  - Pick another branch: the files and commits change, and opening a file's diff uses the new base.
  - Relaunch: the choice is kept for that worktree only.
  - Delete the chosen branch from a terminal and refocus: the fallback note shows.
  - Choose **Default**: it's back to today's behaviour.
  - Take a screenshot of the picker open.

- [ ] **Step 5: Update the READMEs, mark the roadmap bullet built, and stage** the files above.

---

## Self-review notes

- Spec coverage: G-A in Tasks 1–2. G-B in Tasks 3–4, which cover the arrows, ⌘[ ⌘], mouse buttons, reopening closed tabs, skipping gone places, an in-memory history capped at 50, and the old per-set history removed. G-C in Tasks 5–6, which cover the picker, the per-worktree choice, the unchanged default, the unchanged Changes tab, the merge-base diff, the deleted-branch fallback and Reset (**Default**).
- Deviations from the spec, both minor:
  - The picker is a row at the top of the Branch tab rather than replacing the section's "vs" label. This lets it show when there are no commits yet.
  - The compare choice is in `localStorage` rather than a `<userData>` file.
