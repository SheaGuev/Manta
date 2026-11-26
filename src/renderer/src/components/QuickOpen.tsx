import { useEffect, useRef, useState } from 'react'
import { withoutIpcPrefix } from '../lib/errors'
import { parseQuickOpen, rankFiles, withRecentFirst, type FuzzyMatch } from '../lib/search'

const api = window.manta
const MAX_RESULTS = 50

interface QuickOpenProps {
  root: string
  /** The context's recently opened files, newest first, listed before anything is typed. */
  recent: string[]
  /** `line` is 1-based, from a `name:42` query. */
  onOpen: (relPath: string, line: number | undefined) => void
  onClose: () => void
}

/** Cmd+P: open a file in this context by a fuzzy match on its path. */
export function QuickOpen({ root, recent, onOpen, onClose }: QuickOpenProps): React.JSX.Element {
  const [files, setFiles] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .listFiles(root, 'all')
      .then(setFiles)
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
  }, [root])

  const { query, line } = parseQuickOpen(text)
  const results: FuzzyMatch[] = query
    ? withRecentFirst({ ranked: rankFiles(files ?? [], query, MAX_RESULTS), recent })
    : recent.slice(0, MAX_RESULTS).map((path) => ({ path, score: 0, positions: [] }))
  const current = Math.min(selected, Math.max(0, results.length - 1))

  useEffect(() => {
    list.current?.querySelector('.quick-open-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const open = (match: FuzzyMatch | undefined): void => {
    if (!match) return
    onOpen(match.path, line)
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') setSelected(Math.min(current + 1, results.length - 1))
    else if (event.key === 'ArrowUp') setSelected(Math.max(current - 1, 0))
    else if (event.key === 'Enter') open(results[current])
    else return
    event.preventDefault()
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog quick-open" onKeyDown={onKeyDown}>
        <input
          autoFocus
          spellCheck={false}
          value={text}
          placeholder="Go to file (name:line opens at a line)"
          onChange={(e) => {
            setText(e.target.value)
            setSelected(0)
          }}
        />
        <div className="quick-open-list" ref={list}>
          {error ? (
            <p className="dialog-error">{error}</p>
          ) : results.length === 0 ? (
            <p className="muted-row">{query ? (files ? 'No matching files' : 'Loading files…') : 'No recent files'}</p>
          ) : (
            results.map((match, index) => (
              <QuickOpenRow
                key={match.path}
                match={match}
                selected={index === current}
                onHover={() => setSelected(index)}
                onOpen={() => open(match)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function QuickOpenRow({ match, selected, onHover, onOpen }: { match: FuzzyMatch; selected: boolean; onHover: () => void; onOpen: () => void }): React.JSX.Element {
  const nameStart = match.path.lastIndexOf('/') + 1
  const marked = new Set(match.positions)
  const highlight = (from: number, to: number): React.ReactNode[] =>
    match.path.slice(from, to).split('').map((char, i) => (marked.has(from + i) ? <mark key={i}>{char}</mark> : char))
  return (
    <div className={`quick-open-row ${selected ? 'selected' : ''}`} onMouseMove={onHover} onMouseDown={(e) => e.preventDefault()} onClick={onOpen}>
      <span className="quick-open-name">{highlight(nameStart, match.path.length)}</span>
      {nameStart > 0 && <span className="quick-open-folder">{highlight(0, nameStart - 1)}</span>}
    </div>
  )
}
