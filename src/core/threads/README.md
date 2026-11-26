# core/threads

Threads: conversations anchored to a section of a doc, each with its own proposed version of the doc. An implementation thread is anchored the same way but carries an `implementation` link instead: its work runs in a Claude Code session in a code worktree. Full design: [docs/threads.md](../../../docs/threads.md).

| Entry | What it does |
|---|---|
| `threads.ts` | `ThreadIndex`: the `threads` map inside a doc's CRDT, anchors as Yjs relative positions, re-finding sections on a fresh clone (`findQuote`), `sectionAt`, guards for entries and records. **Imported by the renderer: no Node imports.** |
| `implementationBrief.ts` | `implementationBrief`: what an implementation thread's Claude session is told (the doc, the section, the source thread's conversation, the docs repo is read-only, the `Manta-Thread` trailer). Pure. |
| `threadRecords.ts` | `ThreadRecordStore`: reads and writes the export of each thread, `.manta/threads/<id>.json`. `MANTA_DIR` (`.manta`) is kept out of git and out of commits. |
| `threadForks.ts` | `ThreadFork` / `ThreadForkStore`: each thread's fork of the doc (or of its parent's fork), persisted under `.git/manta/threads/<id>/`, `fork.bin` written last. |

**Imports:** `threads.ts` uses only `../../shared/ipc.ts` and Yjs. `threadRecords.ts` uses `threads.ts`. `implementationBrief.ts` uses only `../../shared/ipc.ts`. `threadForks.ts` uses `../docs/`.

**Tests:** `__tests__/threads.test.ts`, `__tests__/threadForks.test.ts`, `__tests__/implementationBrief.test.ts`. Create, agent turns, approve and subthreads end to end: `../__tests__/workspaceThreads.test.ts`.
