import { useEffect, useRef, useState } from 'react'
import type { OpResult } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'

const api = window.manta

interface ClaudeCommandDialogProps {
  onClose: () => void
  onSaved: (result: OpResult) => void
}

/** Edits the extra arguments Claude sessions start with. Enter saves, Escape or a click outside cancels. */
export function ClaudeCommandDialog({ onClose, onSaved }: ClaudeCommandDialogProps): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const loaded = text !== null

  useEffect(() => {
    api
      .claudeArgs()
      .then(setText)
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
  }, [])

  /** The field is disabled until the saved text arrives, and a disabled field ignores `autoFocus`. */
  useEffect(() => {
    if (loaded) input.current?.focus()
  }, [loaded])

  const save = (): void => {
    if (text === null || saving) return
    setSaving(true)
    api
      .setClaudeArgs(text)
      .then((result) => (result.ok ? onSaved(result) : setError(result.message)))
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
      .finally(() => setSaving(false))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>Claude command</h2>
        <p className="muted-row">Extra arguments for new and resumed Claude sessions, in every context. Running sessions keep theirs.</p>
        <label className="command-field">
          <code>claude</code>
          <input
            ref={input}
            spellCheck={false}
            value={text ?? ''}
            disabled={text === null}
            placeholder="--dangerously-skip-permissions"
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
          />
        </label>
        {error ? <p className="dialog-error">{error}</p> : <p className="muted-row">Manta adds --settings and --session-id (or --resume) itself.</p>}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button accent" disabled={text === null || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
