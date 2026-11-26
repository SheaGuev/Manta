import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { withoutIpcPrefix } from '../lib/errors'
import { fuzzyMatch } from '../lib/search'

const api = window.manta

interface BranchPickerProps {
  root: string
  /** The chosen branch; null for the default. */
  current: string | null
  /** What the branch is compared with now, for the trigger; null when nothing. */
  label: string | null
  onChoose: (base: string | null) => void
}

/** "vs <branch> ▾": picks the branch the Branch tab compares with, or the default. */
export function BranchPicker({ root, current, label, onChoose }: BranchPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="popover-anchor branch-picker" ref={anchor}>
      <button className="branch-picker-trigger" title="Compare with another branch" onClick={() => setOpen((o) => !o)}>
        <span className="muted">vs</span> {label ?? 'nothing'}
        <ChevronDown size={12} />
      </button>
      {open && (
        <BranchList
          root={root}
          current={current}
          onChoose={(base) => {
            setOpen(false)
            onChoose(base)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** One row: the default (null) or a branch. */
type Choice = { base: string | null; text: string }

function BranchList({ root, current, onChoose, onClose }: { root: string; current: string | null; onChoose: (base: string | null) => void; onClose: () => void }): React.JSX.Element {
  const [branches, setBranches] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .branches(root)
      .then(setBranches)
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
  }, [root])

  /** Recency order until something is typed, then best match first. */
  const matched = query
    ? (branches ?? [])
        .flatMap((branch) => {
          const match = fuzzyMatch(branch, query)
          return match ? [match] : []
        })
        .sort((a, b) => b.score - a.score)
        .map((match) => match.path)
    : (branches ?? [])
  const choices: Choice[] = [...(query ? [] : [{ base: null, text: 'Default' }]), ...matched.map((branch) => ({ base: branch, text: branch }))]
  const at = Math.min(selected, Math.max(0, choices.length - 1))

  useEffect(() => {
    list.current?.querySelector('.quick-open-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') setSelected(Math.min(at + 1, choices.length - 1))
    else if (event.key === 'ArrowUp') setSelected(Math.max(at - 1, 0))
    else if (event.key === 'Enter') {
      const choice = choices[at]
      if (choice) onChoose(choice.base)
    } else return
    event.preventDefault()
  }

  return (
    <div className="popover quick-open branch-picker-popover" onKeyDown={onKeyDown}>
      <input
        autoFocus
        spellCheck={false}
        value={query}
        placeholder="Compare with branch…"
        onChange={(e) => {
          setQuery(e.target.value)
          setSelected(0)
        }}
      />
      <div className="quick-open-list" ref={list}>
        {error ? (
          <p className="dialog-error">{error}</p>
        ) : choices.length === 0 ? (
          <p className="muted-row">{branches ? 'No matching branches' : 'Loading branches…'}</p>
        ) : (
          choices.map((choice, index) => (
            <div
              key={choice.base ?? ''}
              className={`quick-open-row ${index === at ? 'selected' : ''}`}
              onMouseMove={() => setSelected(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChoose(choice.base)}
            >
              <span className="quick-open-name">{choice.text}</span>
              {choice.base === current && <Check size={13} className="branch-picker-check" />}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
