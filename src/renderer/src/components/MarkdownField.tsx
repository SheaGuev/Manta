import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView, keymap, placeholder as placeholderText } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { livePreview } from '../lib/livePreview'

interface MarkdownFieldProps {
  value: string
  placeholder: string
  /** Called on blur or ⌘Enter when the text changed. */
  onSave: (text: string) => void
  className?: string
}

/**
 * Markdown that reads as rendered and edits in place, like a doc: click to type, ⌘Enter or a click
 * away saves, Escape puts back what was there. For short text stored outside the docs (a ticket's
 * description), so there's no CRDT behind it.
 */
export function MarkdownField({ value, placeholder, onSave, className }: MarkdownFieldProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const saved = useRef(value)
  const save = useRef(onSave)

  useEffect(() => {
    save.current = onSave
  }, [onSave])

  useEffect(() => {
    if (!host.current) return
    const revert = (target: EditorView): boolean => {
      target.dispatch({ changes: { from: 0, to: target.state.doc.length, insert: saved.current } })
      target.contentDOM.blur()
      return true
    }
    const editor = new EditorView({
      parent: host.current,
      doc: saved.current,
      extensions: [
        history(),
        keymap.of([
          { key: 'Mod-Enter', run: (target) => (target.contentDOM.blur(), true) },
          { key: 'Escape', run: revert },
          ...defaultKeymap,
          ...historyKeymap
        ]),
        markdown({ base: markdownLanguage }),
        livePreview,
        EditorView.lineWrapping,
        placeholderText(placeholder),
        EditorView.domEventHandlers({
          blur: (_event, target) => {
            const text = target.state.doc.toString()
            if (text === saved.current) return
            saved.current = text
            save.current(text)
          }
        })
      ]
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [placeholder])

  /** The stored text changed elsewhere (an agent, another window): show it unless the user is typing. */
  useEffect(() => {
    saved.current = value
    const editor = view.current
    if (!editor || editor.hasFocus || editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className={`map-markdown-field ${className ?? ''}`} />
}
