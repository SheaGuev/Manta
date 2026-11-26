import type { EditorTheme } from '../../../shared/ipc'

/** A built-in theme with where it came from, for the Plugins view. */
export interface BuiltinTheme {
  theme: EditorTheme
  description: string
  credit: string
  homepage: string
}

/** Every colour, the code editor's and the terminal's included, is in `style.css` under `[data-app-theme]`. */
export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    theme: { name: 'Armada', dark: true, vars: {}, app: 'armada' },
    description: 'A dark theme inspired by JetBrains Fleet and Air. Colours the whole app, the code editor and terminals.',
    credit: 'David Septimus · MIT',
    homepage: 'https://github.com/DavidSeptimus/armada-theme-orca-plugin'
  }
]

let applied: string[] = []
const listeners = new Set<() => void>()

/**
 * Sets a theme's `--code-*` variables and its built-in app theme on the page, or clears them for
 * Manta's own colours. Every code editor follows at once; terminals repaint through `onThemeChange`.
 */
export function applyEditorTheme(theme: EditorTheme | null): void {
  const root = document.documentElement
  for (const name of applied) root.style.removeProperty(name)
  applied = []
  for (const [name, value] of Object.entries(theme?.vars ?? {})) {
    if (!name.startsWith('--code-')) continue
    root.style.setProperty(name, value)
    applied.push(name)
  }
  if (theme?.app) root.dataset.appTheme = theme.app
  else delete root.dataset.appTheme
  for (const listener of listeners) listener()
}

/** Calls `listener` after each theme change; returns the unsubscribe. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
