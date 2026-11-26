# core/format

Formatting a file with the project's own formatter, for Cmd+S. `main/` runs it on the doc's current text and hands the output to `Workspace.applyFormatted`, which applies it as minimal CRDT edits.

| Entry | What it does |
|---|---|
| `formatters.ts` | `resolveFormatter`: the project's formatter for a file, from its config (looked for from the file's folder up to the root) and its installed tool (in the root, or the project's main checkout for a worktree without `node_modules`): Prettier first, then Biome, then Ruff for Python; null leaves it to the language server. `runFormatter`: stdin to stdout, with a 5 s timeout and the end of stderr on failure. |

**Imports:** `../terminal/terminalEnv.ts` (`findOnPath`) only.

**Tests:** `__tests__/formatters.test.ts`: resolution against temp projects with configs and stub tools, the runner with scripted formatters, and the real Prettier and Biome when `MANTA_FORMATTER_PROJECT` names a project that has them installed.
