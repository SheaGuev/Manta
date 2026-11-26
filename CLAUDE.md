# Manta

Electron app for living docs: a git repo of markdown where each file is backed by a Yjs CRDT, with threads (agent conversations anchored to sections) inside docs. What it is and how it works: [README.md](README.md). Where it's going: [docs/roadmap.md](docs/roadmap.md).

## Commands

```sh
npm run typecheck
npm test            # vitest, real temp git repos; ~25 s
npm run build
npm run app         # build and run with the real profile: how the user runs Manta
npm run dev         # hot reload, own profile (manta-dev); main/preload edits restart it
```

Run typecheck and tests before calling a change done.

## Finding your way

- **Every folder under `src/` has a `README.md`** with one row per file. Read the folder's README before editing in it, and start at [src/README.md](src/README.md) for the process split and import rules.
- **When you add, remove or rename a file, update its folder's README table** in the same change. `src/__tests__/directoryReadmes.test.ts` fails until the table lists exactly the folder's files and subfolders.
- **Tests go in `__tests__/` beside the code they cover**, named `<file>.test.ts`.
- Deep dives: [docs/living-docs.md](docs/living-docs.md) (CRDT ↔ file ↔ git), [docs/threads.md](docs/threads.md) (threads, forks, approve, the agent fence, UI e2e), [docs/terminals.md](docs/terminals.md) (terminals, tracked Claude sessions), [docs/implementation-threads.md](docs/implementation-threads.md) (implementation threads), [docs/code-editor.md](docs/code-editor.md) (the code editor: language servers, format on save, plugins), [docs/context-maps.md](docs/context-maps.md) (context maps), [docs/reviews.md](docs/reviews.md) (review comments on diffs, sent to agents).

## Rules

- **Follow [docs/patterns.md](docs/patterns.md).** No `as` casts, guards for outside data, the serial queue, atomic writes, `OpResult` for refusals, transaction origins, comment style. If a pattern doesn't fit, raise it rather than working around it.
- **Respect the boundaries in [src/README.md](src/README.md):** the renderer has no Node access and imports `core/` only through `core/threads/threads.ts`; `shared/` imports nothing; `core/` never imports Electron.
- **Live runs against Claude Code spend the user's usage: ask first.** Tests and UI e2e use the scripted agent (`MANTA_FAKE_AGENT=1`).
- **Reproduce bugs on a read-only copy of the user's data in `/tmp`**, never the real vault; run the instance with `MANTA_USER_DATA=/tmp/...`.
