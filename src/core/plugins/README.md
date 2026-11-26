# core/plugins

Plugins for the code editor: language servers, linters and formatters installed from Mason's registry into Manta's tools folder, run with Manta's own launch recipes, and editor colour themes from Open VSX. Declarative only: nothing a plugin ships runs inside Manta; its servers are separate processes, like the user's own tools. `main/` composes these.

| Entry | What it does |
|---|---|
| `pluginManager.ts` | `PluginManager`: `<userData>/plugins/plugins.json` (installed tools, switched-off servers, custom servers, the editor theme), Mason's registry cached for a day (and used offline), the SchemaStore catalog for JSON, install and remove, and `specs()`: the servers to run, built-in first. `parsePluginState`. |
| `recipes.ts` | `RECIPES`: how to run each server in the core set (command, languages, primary or lint, the project config a linter needs, settings for `workspace/configuration`, server-specific requests), written from nvim-lspconfig's specs. |
| `installer.ts` | `installPackage`: npm (`--ignore-scripts`), PyPI (a virtualenv, with `uv` when present), GitHub release assets and other downloads (tar, zip, gz, raw), cargo and go. Installs in place and puts the previous install back if anything fails. |
| `masonRegistry.ts` | Mason's `registry.json`: `parseRegistry`, `parsePurl`, `platformTargets`, `renderTemplate` (`{{ version \| strip_prefix "v" }}`), and `installPlan`, how to install a package on this machine or why it can't be. |
| `themes.ts` | Open VSX search and download (`searchThemes`, `themeVariants`), `convertTheme` (a VS Code theme's colours and TextMate token scopes to `--code-*` variables), `parseJsonc`, `parseEditorTheme` (only `--code-*` variables). |
| `zip.ts` | `readZip`: stored and deflated entries, for the registry and `.vsix` files. Release assets with executables are unpacked with the system's `unzip`, which keeps file modes. |

**Imports:** `../lsp/serverCatalog.ts` (types), `../terminal/terminalEnv.ts` (`findOnPath`), `../../shared/`.

**Tests:** `__tests__/`: the registry against real entries (`fixtures/mason-packages.json`), installs from a local HTTP server (and from npm and PyPI with `MANTA_NETWORK_TESTS=1`), the manager against a fake registry, theme conversion (and Open VSX with the same flag), the zip reader.
