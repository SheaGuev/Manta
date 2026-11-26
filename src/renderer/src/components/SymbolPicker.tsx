import { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { fileSymbols, type FileSymbol } from '../lib/lsp/symbols'
import { fuzzyMatch } from '../lib/search'

const MAX_RESULTS = 100

interface SymbolPickerProps {
  view: EditorView
  onClose: () => void
}

/** Cmd+Shift+O: jump to a function, class or other symbol in the file, by a fuzzy match on its name. */
export function SymbolPicker({ view, onClose }: SymbolPickerProps): React.JSX.Element {
  const [symbols, setSymbols] = useState<FileSymbol[] | null | 'none'>(null)
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fileSymbols(view).then(
      (found) => setSymbols(found ?? 'none'),
      () => setSymbols('none')
    )
  }, [view])

  const query = text.trim()
  const results = Array.isArray(symbols)
    ? query
      ? symbols
          .flatMap((symbol) => {
            const match = fuzzyMatch(symbol.name, query)
            return match ? [{ symbol, match }] : []
          })
          .sort((a, b) => b.match.score - a.match.score)
          .slice(0, MAX_RESULTS)
      : symbols.slice(0, MAX_RESULTS).map((symbol) => ({ symbol, match: null }))
    : []
  const current = Math.min(selected, Math.max(0, results.length - 1))

  useEffect(() => {
    list.current?.querySelector('.quick-open-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const go = (symbol: FileSymbol | undefined): void => {
    if (!symbol) return
    onClose()
    view.dispatch({ selection: { anchor: symbol.from }, effects: EditorView.scrollIntoView(symbol.from, { y: 'center' }) })
    view.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') setSelected(Math.min(current + 1, results.length - 1))
    else if (event.key === 'ArrowUp') setSelected(Math.max(current - 1, 0))
    else if (event.key === 'Enter') go(results[current]?.symbol)
    else return
    event.preventDefault()
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog quick-open symbol-picker" onKeyDown={onKeyDown}>
        <input
          autoFocus
          spellCheck={false}
          value={text}
          placeholder="Go to symbol in file"
          onChange={(e) => {
            setText(e.target.value)
            setSelected(0)
          }}
        />
        <div className="quick-open-list" ref={list}>
          {symbols === null ? (
            <p className="muted-row">Asking the language server…</p>
          ) : symbols === 'none' ? (
            <p className="muted-row">This file's language server doesn't list symbols.</p>
          ) : results.length === 0 ? (
            <p className="muted-row">No matching symbols</p>
          ) : (
            results.map(({ symbol, match }, index) => {
              const marked = new Set(match?.positions ?? [])
              return (
                <div
                  key={`${symbol.from}:${symbol.name}`}
                  className={`quick-open-row ${index === current ? 'selected' : ''}`}
                  onMouseMove={() => setSelected(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(symbol)}
                >
                  <span className="quick-open-name">
                    {symbol.name.split('').map((char, i) => (marked.has(i) ? <mark key={i}>{char}</mark> : char))}
                  </span>
                  <span className="quick-open-folder">
                    {symbol.kind}
                    {symbol.container ? ` in ${symbol.container}` : ''}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
