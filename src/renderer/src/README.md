# renderer/src

The app shell and its entry point.

| Entry | What it does |
|---|---|
| `main.tsx` | Mounts `App`. |
| `App.tsx` | The shell: work context (the docs repo, a worktree, or a context map, which has its own tabs beside the docs repo's and a Home tab that can't be closed; a map's sessions open in their worktree's context), tabs per context (docs, threads, terminals, a map), back and forward across contexts, session persisted to `localStorage`, resizable sidebar and right panel, onboarding when no docs repo is set. |
| `env.d.ts` | Types `window.manta` as `MantaApi` and the CSS custom properties set from React. |
| `style.css` | All styles. CSS variables (`--bg-*`, `--text-*`, `--accent`, ...) at the top; reuse `.row`, `.icon-button`, `.primary-button`, `.popover`, `.badge`. |
| `components/` | React components, one per file. |
| `lib/` | Hooks, CodeMirror extensions and pure helpers. Unit-tested. |

**Imports:** `../../shared/ipc.ts` for types; `core/` only via `lib/threadMarkers.ts`. Conventions for effects, refs and CodeMirror: [docs/patterns.md](../../../docs/patterns.md) → Renderer.
