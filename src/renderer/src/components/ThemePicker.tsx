import { Check, ExternalLink, Loader2, Palette } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EditorTheme, OpResult, ThemeEntry } from '../../../shared/ipc'
import { applyEditorTheme, BUILTIN_THEMES } from '../lib/editorTheme'
import { withoutIpcPrefix } from '../lib/errors'

const api = window.manta
/** Searching Open VSX waits for typing to pause this long. */
const SEARCH_DELAY_MS = 300

interface ThemePickerProps {
  query: string
  onResult: (result: OpResult) => void
}

const message = (e: unknown): string => withoutIpcPrefix(e instanceof Error ? e.message : String(e))

/** Manta's built-in themes, which restyle the whole app, and VS Code colour themes from Open VSX, for the code editor only. */
export function ThemePicker({ query, onResult }: ThemePickerProps): React.JSX.Element {
  const [themes, setThemes] = useState<ThemeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<EditorTheme | null>(null)
  const [variants, setVariants] = useState<{ id: string; list: EditorTheme[] } | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  useEffect(() => {
    api.editorTheme().then(setCurrent, (e: unknown) => setError(message(e)))
  }, [])

  useEffect(() => {
    let live = true
    setThemes(null)
    const timer = setTimeout(() => {
      api.searchThemes(query.trim()).then(
        (found) => live && setThemes(found),
        (e: unknown) => live && setError(message(e))
      )
    }, SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  const use = (theme: EditorTheme | null): void => {
    applyEditorTheme(theme)
    setCurrent(theme)
    setVariants(null)
    api.setEditorTheme(theme).then(
      () => onResult({ ok: true, message: theme ? `${theme.app ? 'Theme' : 'Code editor theme'}: ${theme.name}` : "Theme: Manta's own" }),
      (e: unknown) => onResult({ ok: false, message: message(e) })
    )
  }

  const pick = (entry: ThemeEntry): void => {
    setLoading(entry.id)
    api
      .themeVariants(entry.id)
      .then((list) => {
        const [only] = list
        if (list.length === 1 && only) use(only)
        else setVariants({ id: entry.id, list })
      })
      .catch((e: unknown) => onResult({ ok: false, message: message(e) }))
      .finally(() => setLoading(null))
  }

  return (
    <div className="plugins-list">
      <div className="plugin-row">
        <div className="plugin-main">
          <div className="plugin-title">
            <Palette size={14} />
            <span className="plugin-name">{current ? current.name : "Manta's own colours"}</span>
            <span className="plugin-version">{current?.app ? 'app theme' : 'code editor theme'}</span>
          </div>
        </div>
        <div className="plugin-actions">
          {current && (
            <button className="primary-button" onClick={() => use(null)}>
              Use Manta's
            </button>
          )}
        </div>
      </div>
      {!query.trim() && <p className="muted-row plugins-message">Built in</p>}
      {BUILTIN_THEMES.filter(({ theme }) => theme.name.toLowerCase().includes(query.trim().toLowerCase())).map(({ theme, description, credit, homepage }) => (
        <div key={theme.name} className="plugin-row" data-theme={`builtin:${theme.app ?? theme.name}`}>
          <div className="plugin-main">
            <div className="plugin-title">
              <span className="plugin-name">{theme.name}</span>
              <span className="badge">Built in</span>
              <span className="plugin-version">{credit}</span>
              <a className="icon-button" title={homepage} href={homepage} target="_blank" rel="noreferrer">
                <ExternalLink size={12} />
              </a>
            </div>
            <p className="plugin-description">{description}</p>
          </div>
          <div className="plugin-actions">
            {current?.app === theme.app ? (
              <Check size={14} className="plugin-installed" />
            ) : (
              <button className="primary-button" onClick={() => use(theme)}>
                Use
              </button>
            )}
          </div>
        </div>
      ))}
      {!query.trim() && <p className="muted-row plugins-message">From Open VSX: code editor only</p>}
      {error ? (
        <p className="dialog-error plugins-message">{error}</p>
      ) : !themes ? (
        <p className="muted-row plugins-message">Searching Open VSX…</p>
      ) : (
        themes.map((entry) => (
          <div key={entry.id} className="plugin-row" data-theme={entry.id}>
            <div className="plugin-main">
              <div className="plugin-title">
                {entry.icon && <img className="theme-icon" src={entry.icon} alt="" />}
                <span className="plugin-name">{entry.name}</span>
                <span className="plugin-version">{entry.publisher} · {entry.downloads.toLocaleString()} downloads</span>
              </div>
              <p className="plugin-description">{entry.description}</p>
              {variants?.id === entry.id && (
                <div className="plugin-servers">
                  {variants.list.map((variant) => (
                    <button key={variant.name} className="primary-button" onClick={() => use(variant)}>
                      {current?.name === variant.name && <Check size={12} />} {variant.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="plugin-actions">
              {loading === entry.id ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <button className="primary-button" onClick={() => pick(entry)}>
                  Use
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
