import { LSPPlugin } from '@codemirror/lsp-client'
import { StateEffect, StateField, type Text } from '@codemirror/state'
import { EditorView, showPanel, type Command, type Panel } from '@codemirror/view'
import { relativeTo, uriPath } from './fileUris'
import type { ClientRoot } from './rename'
import type { TextEdit } from './workspaceEdits'

type Range = TextEdit['range']

interface Reference {
  uri: string
  /** Shown above the file's lines: relative to the root when inside it. */
  file: string
  range: Range
  /** 1-based. */
  line: number
  text: string
  /** Columns of the reference within `text`. */
  from: number
  to: number
}

interface Location {
  uri: string
  range: Range
}

function isLocation(value: unknown): value is Location {
  return typeof value === 'object' && value !== null && 'uri' in value && typeof value.uri === 'string' && 'range' in value
}

const setReferences = StateEffect.define<Reference[] | null>()

const referencesField = StateField.define<Reference[] | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setReferences)) return effect.value
    return value
  },
  provide: (field) => showPanel.from(field, (refs) => (refs ? (view) => referencePanel(view, refs) : null))
})

function offsetIn(doc: Text, position: Range['start']): number {
  if (position.line >= doc.lines) return doc.length
  const line = doc.line(position.line + 1)
  return Math.min(line.from + position.character, line.to)
}

/** Opens the reference's file (its tab, or a new one) and puts the cursor on it. */
async function goTo(view: EditorView, ref: Reference): Promise<void> {
  const plugin = LSPPlugin.get(view)
  if (!plugin) return
  const target = uriPath(ref.uri) === uriPath(plugin.uri) ? view : await plugin.client.workspace.displayFile(ref.uri)
  if (!target) return
  const pos = offsetIn(target.state.doc, ref.range.start)
  target.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  target.focus()
}

function referencePanel(view: EditorView, refs: Reference[]): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-lsp-reference-panel'
  dom.tabIndex = 0
  dom.setAttribute('role', 'listbox')
  dom.setAttribute('aria-label', 'References')
  const options: HTMLElement[] = []
  let file: string | null = null
  for (const ref of refs) {
    if (ref.file !== file) {
      file = ref.file
      const header = dom.appendChild(document.createElement('div'))
      header.className = 'cm-lsp-reference-file'
      header.textContent = ref.file
    }
    const entry = dom.appendChild(document.createElement('div'))
    entry.className = 'cm-lsp-reference'
    entry.setAttribute('role', 'option')
    const number = entry.appendChild(document.createElement('span'))
    number.className = 'cm-lsp-reference-line'
    number.textContent = `${ref.line}: `.padStart(6, ' ')
    const start = Math.max(0, ref.from - 50)
    entry.appendChild(document.createTextNode(ref.text.slice(start, ref.from)))
    entry.appendChild(document.createElement('strong')).textContent = ref.text.slice(ref.from, ref.to)
    entry.appendChild(document.createTextNode(ref.text.slice(ref.to, ref.to + 100)))
    entry.addEventListener('click', () => void goTo(view, ref))
    options.push(entry)
  }
  let selected = 0
  const select = (index: number): void => {
    options[selected]?.removeAttribute('aria-selected')
    selected = (index + options.length) % options.length
    options[selected]?.setAttribute('aria-selected', 'true')
    options[selected]?.scrollIntoView({ block: 'nearest' })
  }
  select(0)
  dom.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      view.dispatch({ effects: setReferences.of(null) })
      view.focus()
    } else if (event.key === 'ArrowDown') select(selected + 1)
    else if (event.key === 'ArrowUp') select(selected - 1)
    else if (event.key === 'Enter') {
      const ref = refs[selected]
      if (ref) void goTo(view, ref)
    } else return
    event.preventDefault()
  })
  return { dom, mount: () => dom.focus() }
}

/**
 * Shift+F12: every reference to the symbol at the cursor, in a panel under the editor, grouped by file.
 * Replaces lsp-client's panel, which can only list files that have an open tab.
 */
export function findReferencesEverywhere(clientRoot: ClientRoot): Command {
  return (view) => {
    const plugin = LSPPlugin.get(view)
    if (!plugin || !plugin.client.serverCapabilities?.referencesProvider) return false
    const { client } = plugin
    client.sync()
    const position = plugin.toPosition(view.state.selection.main.head)
    void (async () => {
      try {
        const response = await client.request('textDocument/references', { textDocument: { uri: plugin.uri }, position, context: { includeDeclaration: true } })
        const locations = Array.isArray(response) ? response.filter(isLocation) : []
        const where = clientRoot(client)
        const texts = new Map<string, Text | null>()
        const refs: Reference[] = []
        for (const location of locations) {
          if (!texts.has(location.uri)) texts.set(location.uri, (await client.workspace.requestFile(location.uri))?.doc ?? null)
          const doc = texts.get(location.uri)
          if (!doc) continue
          const from = offsetIn(doc, location.range.start)
          const line = doc.lineAt(from)
          const to = Math.min(offsetIn(doc, location.range.end), line.to)
          const file = (where && relativeTo(where.rootUri, location.uri)) ?? uriPath(location.uri)
          refs.push({ uri: location.uri, file, range: location.range, line: line.number, text: line.text, from: from - line.from, to: to - line.from })
        }
        if (refs.length === 0) return
        const effects = view.state.field(referencesField, false) === undefined ? StateEffect.appendConfig.of(referencesField.init(() => refs)) : setReferences.of(refs)
        view.dispatch({ effects })
      } catch (error) {
        plugin.reportError('Finding references failed', error)
      }
    })()
    return true
  }
}
