import type { EditorTheme } from '../../../shared/ipc'

let applied: string[] = []

/** Sets a theme's `--code-*` variables on the page, or clears them for Manta's own colours. Every code editor follows at once. */
export function applyEditorTheme(theme: EditorTheme | null): void {
  const root = document.documentElement
  for (const name of applied) root.style.removeProperty(name)
  applied = []
  for (const [name, value] of Object.entries(theme?.vars ?? {})) {
    if (!name.startsWith('--code-')) continue
    root.style.setProperty(name, value)
    applied.push(name)
  }
}
