import type { EditorView } from '@codemirror/view'
import { Lightbulb } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OpResult } from '../../../shared/ipc'
import { clientRoot } from '../lib/lsp/clients'
import { applyQuickFix, quickFixes, type QuickFix } from '../lib/lsp/codeActions'

interface QuickFixPickerProps {
  view: EditorView
  onClose: () => void
  onResult: (result: OpResult) => void
}

/** Cmd+.: the language server's quick fixes and refactors for the cursor's line, such as adding a missing import. */
export function QuickFixPicker({ view, onClose, onResult }: QuickFixPickerProps): React.JSX.Element {
  const [fixes, setFixes] = useState<QuickFix[] | null | 'none'>(null)
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    quickFixes(view).then(
      (found) => setFixes(found ?? 'none'),
      () => setFixes('none')
    )
  }, [view])

  const list = Array.isArray(fixes) ? fixes : []
  const current = Math.min(selected, Math.max(0, list.length - 1))

  const apply = (fix: QuickFix | undefined): void => {
    if (!fix) return
    onClose()
    applyQuickFix({ view, fix, clientRoot })
      .then(() => view.focus())
      .catch((error: unknown) => onResult({ ok: false, message: `${fix.title} failed: ${error instanceof Error ? error.message : String(error)}` }))
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') setSelected(Math.min(current + 1, list.length - 1))
    else if (event.key === 'ArrowUp') setSelected(Math.max(current - 1, 0))
    else if (event.key === 'Enter') apply(list[current])
    else return
    event.preventDefault()
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Focusable so arrow keys and Enter work without an input. */}
      <div className="dialog quick-open quick-fixes" tabIndex={-1} ref={(element) => element?.focus()} onKeyDown={onKeyDown}>
        <div className="quick-open-list">
          {fixes === null ? (
            <p className="muted-row">Asking the language server…</p>
          ) : fixes === 'none' ? (
            <p className="muted-row">This file's language server has no quick fixes.</p>
          ) : list.length === 0 ? (
            <p className="muted-row">No quick fixes on this line</p>
          ) : (
            list.map((fix, index) => (
              <div
                key={`${index}:${fix.title}`}
                className={`quick-open-row ${index === current ? 'selected' : ''}`}
                onMouseMove={() => setSelected(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(fix)}
              >
                {fix.preferred && <Lightbulb size={12} />}
                <span className="quick-open-name">{fix.title}</span>
                <span className="quick-open-folder">{fix.kind}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
