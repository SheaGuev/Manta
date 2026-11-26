# renderer

The React UI, built by electron-vite (`electron.vite.config.mts`). No Node access: everything goes through `window.manta`.

| Entry | What it does |
|---|---|
| `index.html` | Page shell that loads `src/main.tsx`. |
| `src/` | The app: shell, components, editor extensions and helpers. |
