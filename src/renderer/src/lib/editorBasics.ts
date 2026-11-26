import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord } from '@codemirror/autocomplete'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, rectangularSelection } from '@codemirror/view'

/** Opens find and replace with the replace field focused, as Cmd+Opt+F does in VS Code. */
function openReplace(view: EditorView): boolean {
  openSearchPanel(view)
  view.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')?.focus()
  return true
}

/**
 * Find and replace in the file (Cmd+F, Cmd+Opt+F) for docs and code; `searchKeymap` also brings Cmd+D
 * (select the next occurrence) and Cmd+Shift+L (select all of them).
 * Prec.high because the editor's own keymap comes first and would otherwise take Escape.
 */
export const findInFile: Extension = [search({ top: true }), Prec.high(keymap.of([...searchKeymap, { key: 'Mod-Alt-f', run: openReplace }]))]

/** Completion from the words already in the file, for code without a language server. */
export const wordCompletion: Extension = autocompletion({ override: [completeAnyWord] })

/** What a developer expects from a code editor beyond typing: folding, brackets, multiple cursors. */
export const codeEditing: Extension = [
  EditorState.allowMultipleSelections.of(true),
  /** Opt-click adds a cursor, as in VS Code; CodeMirror's default, Cmd-click, is kept for go to definition. */
  EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
  foldGutter(),
  bracketMatching(),
  closeBrackets(),
  indentOnInput(),
  highlightSelectionMatches(),
  /** Ahead of the default keymap, so Backspace between a pair of brackets deletes both. */
  Prec.high(keymap.of([...closeBracketsKeymap, ...foldKeymap, { key: 'Ctrl-g', run: gotoLine }]))
]
