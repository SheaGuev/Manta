import { ChevronRight, FileText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { groupByFile, highlightParts, matchFileNames, type FileMatches } from '../lib/search'

const api = window.manta

const MAX_FILE_RESULTS = 200
/** Content search shells out to git grep; wait for a pause in typing rather than run it per keystroke. */
const CONTENT_SEARCH_DELAY_MS = 200

type Section = 'files' | 'content'

interface SearchResultsProps {
  root: string
  files: readonly string[]
  query: string
  /** Only lines in these files, when given (a context map's docs). */
  only?: readonly string[] | null
  /** `line` is 1-based; absent for a file-name match. */
  onOpen: (relPath: string, line?: number) => void
  onError: (message: string) => void
}

/** File-name matches first, then matching lines grouped by file; each section collapses. */
export function SearchResults({ root, files, query, only = null, onOpen, onError }: SearchResultsProps): React.JSX.Element {
  const names = useMemo(() => matchFileNames(files, query, MAX_FILE_RESULTS), [files, query])
  const [content, setContent] = useState<{ query: string; groups: FileMatches[] } | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<Section>>(new Set())

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api
        .searchContent(root, query)
        .then((matches) => live && setContent({ query, groups: groupByFile(only ? matches.filter((m) => only.includes(m.path)) : matches) }))
        .catch((error: unknown) => live && onError(error instanceof Error ? error.message : String(error)))
    }, CONTENT_SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [root, query, only, onError])

  const toggle = (section: Section): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  const groups = content?.query === query ? content.groups : null
  const lineCount = groups?.reduce((sum, group) => sum + group.matches.length, 0) ?? 0

  return (
    <div className="search-results">
      <SectionHeader label="Files" count={String(names.length)} open={!collapsed.has('files')} onToggle={() => toggle('files')} />
      {!collapsed.has('files') &&
        (names.length === 0 ? (
          <div className="row muted-row search-empty">No file names match</div>
        ) : (
          names.map((path) => (
            <div key={path} className="row search-file" title={path} onClick={() => onOpen(path)}>
              <FileText size={14} />
              <PathLabel path={path} query={query} />
            </div>
          ))
        ))}

      <SectionHeader
        label="Content"
        count={groups ? `${lineCount} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'}` : '…'}
        open={!collapsed.has('content')}
        onToggle={() => toggle('content')}
      />
      {!collapsed.has('content') &&
        (groups === null ? (
          <div className="row muted-row search-empty">Searching…</div>
        ) : groups.length === 0 ? (
          <div className="row muted-row search-empty">No file contents match</div>
        ) : (
          groups.map((group) => (
            <div key={group.path}>
              <div className="row search-file" title={group.path} onClick={() => onOpen(group.path, group.matches[0]?.line)}>
                <FileText size={14} />
                <PathLabel path={group.path} query="" />
                <span className="badge">{group.matches.length}</span>
              </div>
              {group.matches.map((match) => (
                <div key={match.line} className="row search-line" onClick={() => onOpen(match.path, match.line)}>
                  <span className="line-number">{match.line}</span>
                  <span className="label">
                    <Highlighted text={match.text} query={query} />
                  </span>
                </div>
              ))}
            </div>
          ))
        ))}
    </div>
  )
}

function SectionHeader({ label, count, open, onToggle }: { label: string; count: string; open: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <div className="row search-section" onClick={onToggle}>
      <ChevronRight size={14} className={`chevron ${open ? 'open' : ''}`} />
      <span className="label">{label}</span>
      <span className="muted-row">{count}</span>
    </div>
  )
}

function PathLabel({ path, query }: { path: string; query: string }): React.JSX.Element {
  const slash = path.lastIndexOf('/')
  return (
    <span className="label">
      <Highlighted text={path.slice(slash + 1)} query={query} />
      {slash > 0 && <span className="muted-row"> {path.slice(0, slash)}</span>}
    </span>
  )
}

function Highlighted({ text, query }: { text: string; query: string }): React.JSX.Element {
  return (
    <>
      {highlightParts(text, query).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : part.text))}
    </>
  )
}
