import type { EditorView } from '@codemirror/view'

/** How long a jump to another file waits for its tab's editor to mount. */
const MOUNT_TIMEOUT_MS = 5000

/** Opens a tab for a jump target and returns the key its editor registers under. */
export type FileOpener = (root: string, target: { relPath: string | null; absolutePath: string }) => Promise<string | null>

let opener: FileOpener | null = null
const mounted = new Map<string, EditorView>()
const waiting = new Map<string, (view: EditorView) => void>()

/** `App` sets this: it decides between an editable tab and a read-only one. */
export function setFileOpener(open: FileOpener | null): void {
  opener = open
}

/** The key an editor registers under: its root plus its relative path, or the absolute path of a read-only file. */
export function editorKey(root: string, path: string): string {
  return `${root}\0${path}`
}

/** Called by each code editor while it's mounted, so a jump can land in it. */
export function noteEditor(key: string, view: EditorView): () => void {
  mounted.set(key, view)
  waiting.get(key)?.(view)
  waiting.delete(key)
  return () => {
    if (mounted.get(key) === view) mounted.delete(key)
  }
}

/** The mounted editor registered under `key`, e.g. the active tab's, for Cmd+Shift+O. */
export function mountedEditor(key: string): EditorView | null {
  return mounted.get(key) ?? null
}

/** Opens the target's tab and resolves with its editor; null when nothing can show it. */
export async function showFile(root: string, target: { relPath: string | null; absolutePath: string }): Promise<EditorView | null> {
  const key = opener ? await opener(root, target) : null
  if (!key) return null
  const view = mounted.get(key)
  if (view) return view
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(key)
      resolve(null)
    }, MOUNT_TIMEOUT_MS)
    waiting.set(key, (ready) => {
      clearTimeout(timer)
      resolve(ready)
    })
  })
}
