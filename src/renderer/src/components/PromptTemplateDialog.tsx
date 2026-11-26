import { useState } from 'react'

interface PromptTemplateDialogProps {
  initial: string
  /** "Send" the first time PR comments are sent, "Save" when edited from the picker. */
  confirmLabel: string
  onConfirm: (text: string) => void
  onClose: () => void
}

/** The prompt put in front of PR comments sent to an agent. Escape or a click outside cancels. */
export function PromptTemplateDialog({ initial, confirmLabel, onConfirm, onClose }: PromptTemplateDialogProps): React.JSX.Element {
  const [text, setText] = useState(initial)
  const confirm = (): void => {
    if (text.trim()) onConfirm(text.trim())
  }
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog implement-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          confirm()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>Prompt for PR comments</h2>
        <p className="muted-row">Sent to the agent in front of the comments you tick. Change it later from Edit prompt… in the Send to list.</p>
        <label className="dialog-field">
          <span>Prompt</span>
          <textarea
            autoFocus
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                confirm()
              }
            }}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button accent" disabled={!text.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
