import { autocompletion } from '@codemirror/autocomplete'
import { lintGutter } from '@codemirror/lint'
import {
  formatKeymap,
  hoverTooltips,
  jumpToDefinition,
  jumpToDefinitionKeymap,
  serverCompletionSource,
  signatureHelp,
  type LSPClient
} from '@codemirror/lsp-client'
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { pullDiagnostics } from './pullDiagnostics'
import { findReferencesEverywhere } from './references'
import { renameAcrossFiles, type ClientRoot } from './rename'

const setLink = StateEffect.define<{ from: number; to: number } | null>()

/** The word under the pointer while Cmd is held, underlined like a link. */
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(links, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setLink)) continue
      return effect.value ? Decoration.set([Decoration.mark({ class: 'cm-definition-link' }).range(effect.value.from, effect.value.to)]) : Decoration.none
    }
    return tr.docChanged ? links.map(tr.changes) : links
  },
  provide: (field) => EditorView.decorations.from(field)
})

function wordAt(view: EditorView, x: number, y: number): { from: number; to: number } | null {
  const pos = view.posAtCoords({ x, y }, false)
  const word = view.state.wordAt(pos)
  return word && word.from < word.to ? { from: word.from, to: word.to } : null
}

function showLink(view: EditorView, link: { from: number; to: number } | null): void {
  const current = view.state.field(linkField).iter()
  const same = link ? current.value !== null && current.from === link.from && current.to === link.to : current.value === null
  if (!same) view.dispatch({ effects: setLink.of(link) })
}

/** Cmd-click goes to the definition, as in VS Code; Cmd held over a symbol underlines it first. */
const definitionOnCmdClick: Extension = [
  linkField,
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.metaKey || event.button !== 0) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
      view.dispatch({ selection: { anchor: pos } })
      jumpToDefinition(view)
      event.preventDefault()
      return true
    },
    mousemove(event, view) {
      showLink(view, event.metaKey ? wordAt(view, event.clientX, event.clientY) : null)
      return false
    },
    mouseleave(_event, view) {
      showLink(view, null)
      return false
    },
    keyup(event, view) {
      if (event.key === 'Meta') showLink(view, null)
      return false
    }
  })
]

/**
 * What a language server adds to a code editor: hover types and docs, completions, signature help,
 * errors as you type, F12 or Cmd-click to the definition, Shift+F12 references, F2 rename.
 */
export function codeIntelligence({ client, uri, languageId, clientRoot }: { client: LSPClient; uri: string; languageId: string; clientRoot: ClientRoot }): Extension {
  return [
    client.plugin(uri, languageId),
    hoverTooltips(),
    autocompletion({ override: [serverCompletionSource] }),
    signatureHelp(),
    pullDiagnostics,
    lintGutter(),
    definitionOnCmdClick,
    Prec.high(
      keymap.of([
        ...jumpToDefinitionKeymap,
        { key: 'Shift-F12', run: findReferencesEverywhere(clientRoot), preventDefault: true },
        { key: 'F2', run: renameAcrossFiles(clientRoot), preventDefault: true },
        ...formatKeymap
      ])
    )
  ]
}
