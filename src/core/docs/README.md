# core/docs

The living-doc layer: a markdown file backed by a Yjs document, where every text change reaches the CRDT as minimal ops so unchanged text keeps its identity. Full design: [docs/living-docs.md](../../../docs/living-docs.md).

| Entry | What it does |
|---|---|
| `textEdits.ts` | `computeTextEdits` (line diff, then character diff inside changed hunks), `applyTextEdits`, `mergeTextChange` (fork at a snapshot, replay, merge in), `changedRanges`. |
| `livingDoc.ts` | `LivingDoc`: one file's `Y.Doc`, writing to disk, absorbing outside edits, sync points at commits, the staged snapshot a commit of the index turns into a sync point. `RENDERER_ORIGIN`. |
| `docStore.ts` | `DocStore`: persists a doc's CRDT under `.git/manta/docs/<path>/` (append-only update log, `lastDisk`, `syncPoint` and `staged` snapshots, `meta.json` written last). `Snapshot`, `SyncPoint` types. |

**Imports:** `docStore.ts` imports nothing in core. `textEdits.ts` uses `docStore.ts` types. `livingDoc.ts` also uses the `Git` type. Nothing here imports `threads/`.

**Tests:** `__tests__/textEdits.test.ts`, `__tests__/docStore.test.ts` (which snapshot files a save rewrites). The end-to-end behaviour (outside edits, pulls, reopen) is covered in `../__tests__/workspace.test.ts`.
