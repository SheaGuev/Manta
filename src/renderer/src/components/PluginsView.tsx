import { Check, Download, ExternalLink, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OpResult, PluginEntry } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'
import { forgetOpenedServers } from '../lib/lsp/clients'
import { ThemePicker } from './ThemePicker'

const api = window.manta
/** The list renders this many matches; searching narrows it, so the 600 or so packages never all mount. */
const MAX_SHOWN = 80

type Category = 'core' | 'installed' | 'LSP' | 'Linter' | 'Formatter' | 'themes'

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'core', label: 'Core set' },
  { id: 'installed', label: 'Installed' },
  { id: 'LSP', label: 'Languages' },
  { id: 'Linter', label: 'Linters' },
  { id: 'Formatter', label: 'Formatters' },
  { id: 'themes', label: 'Themes' }
]

interface PluginsViewProps {
  onResult: (result: OpResult) => void
}

function matches(entry: PluginEntry, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return [entry.name, entry.description, ...entry.languages, ...entry.servers.map((s) => s.name)].some((text) => text.toLowerCase().includes(needle))
}

function inCategory(entry: PluginEntry, category: Category): boolean {
  if (category === 'core') return entry.servers.some((s) => s.core)
  if (category === 'installed') return entry.installed !== null
  return entry.categories.includes(category)
}

/**
 * Language servers, linters and formatters from Mason's registry, and editor themes from Open VSX.
 * Installing runs nothing inside Manta: a plugin's servers run as their own processes.
 */
export function PluginsView({ onResult }: PluginsViewProps): React.JSX.Element {
  const [entries, setEntries] = useState<PluginEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('core')
  const [busy, setBusy] = useState<Record<string, string>>({})

  const load = useCallback((refresh: boolean) => {
    setError(null)
    api
      .pluginEntries(refresh)
      .then(setEntries)
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
  }, [])
  useEffect(() => load(false), [load])
  useEffect(() => api.onPluginProgress((name, line) => setBusy((b) => (name in b ? { ...b, [name]: line } : b))), [])

  /** Open editors pick up added or removed servers the next time they ask for them. */
  const changed = (result: OpResult): void => {
    onResult(result)
    forgetOpenedServers()
    load(false)
  }

  const act = (name: string, label: string, task: () => Promise<OpResult>): void => {
    setBusy((b) => ({ ...b, [name]: label }))
    task()
      .then(changed)
      .catch((e: unknown) => onResult({ ok: false, message: withoutIpcPrefix(e instanceof Error ? e.message : String(e)) }))
      .finally(() =>
        setBusy((b) => {
          const { [name]: _done, ...rest } = b
          return rest
        })
      )
  }

  const shown = useMemo(
    () => (entries ?? []).filter((e) => inCategory(e, category) && matches(e, query.trim())).slice(0, MAX_SHOWN),
    [entries, category, query]
  )

  return (
    <div className="plugins-view">
      <div className="plugins-header">
        <h2>Plugins</h2>
        <div className="panel-search plugins-search">
          <Search size={14} />
          <input value={query} placeholder="Search by name or language" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="icon-button" title="Check Mason's registry for new versions" onClick={() => load(true)}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="plugins-categories">
        {CATEGORIES.map((c) => (
          <button key={c.id} className={`icon-button ${category === c.id ? 'active' : ''}`} onClick={() => setCategory(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      {category === 'themes' ? (
        <ThemePicker query={query} onResult={onResult} />
      ) : error ? (
        <p className="dialog-error plugins-message">{error}</p>
      ) : !entries ? (
        <p className="muted-row plugins-message">Loading Mason's registry…</p>
      ) : shown.length === 0 ? (
        <p className="muted-row plugins-message">No plugins match.</p>
      ) : (
        <div className="plugins-list">
          {shown.map((entry) => (
            <PluginRow
              key={entry.name}
              entry={entry}
              busy={busy[entry.name] ?? null}
              onInstall={() => act(entry.name, 'Installing…', () => api.installPlugin(entry.name))}
              onRemove={() => act(entry.name, 'Removing…', () => api.removePlugin(entry.name))}
              onToggle={(server, enabled) => act(entry.name, enabled ? 'Switching on…' : 'Switching off…', async () => {
                await api.setPluginServerEnabled(server, enabled)
                return { ok: true, message: `${server} ${enabled ? 'on' : 'off'}` }
              })}
              onAddCustom={(command, languages) =>
                act(entry.name, 'Saving…', () => api.addCustomServer({ package: entry.name, command, args: ['--stdio'], languages }))
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface PluginRowProps {
  entry: PluginEntry
  busy: string | null
  onInstall: () => void
  onRemove: () => void
  onToggle: (server: string, enabled: boolean) => void
  onAddCustom: (command: string, languages: string[]) => void
}

function PluginRow({ entry, busy, onInstall, onRemove, onToggle, onAddCustom }: PluginRowProps): React.JSX.Element {
  const system = entry.installed?.version === 'system'
  const update = entry.installed && entry.version && !system && entry.installed.version !== entry.version
  const [custom, setCustom] = useState<{ command: string; languages: string } | null>(null)
  return (
    <div className="plugin-row" data-plugin={entry.name}>
      <div className="plugin-main">
        <div className="plugin-title">
          <span className="plugin-name">{entry.name}</span>
          {entry.servers.some((s) => s.core) && <span className="badge">Core</span>}
          {entry.servers.some((s) => s.beta) && <span className="badge">Beta</span>}
          {entry.installed && <span className="plugin-version">{system ? 'comes with the system' : entry.installed.version}</span>}
          {entry.homepage && (
            <a className="icon-button" title={entry.homepage} href={entry.homepage} target="_blank" rel="noreferrer">
              <ExternalLink size={12} />
            </a>
          )}
        </div>
        <p className="plugin-description">{entry.servers[0]?.description ?? entry.description}</p>
        <p className="plugin-languages">{[...entry.languages, ...entry.categories].join(' · ')}</p>
        {entry.installed && entry.servers.length > 0 && (
          <div className="plugin-servers">
            {entry.servers.map((server) => (
              <label key={server.id} className="plugin-server">
                <input type="checkbox" checked={server.enabled} disabled={busy !== null} onChange={(e) => onToggle(server.id, e.target.checked)} />
                {server.name} {server.role === 'lint' ? '(lint)' : ''}
              </label>
            ))}
          </div>
        )}
        {entry.installed && !system && entry.servers.length === 0 && entry.categories.includes('LSP') && !custom && (
          <button className="link-button" onClick={() => setCustom({ command: '', languages: entry.languages.map((l) => l.toLowerCase()).join(', ') })}>
            Set up as a language server…
          </button>
        )}
        {custom && (
          <form
            className="plugin-custom"
            onSubmit={(e) => {
              e.preventDefault()
              onAddCustom(custom.command.trim(), custom.languages.split(',').map((l) => l.trim()).filter(Boolean))
              setCustom(null)
            }}
          >
            <input placeholder="Command, e.g. lua-language-server" value={custom.command} onChange={(e) => setCustom({ ...custom, command: e.target.value })} />
            <input placeholder="Language ids, e.g. lua" value={custom.languages} onChange={(e) => setCustom({ ...custom, languages: e.target.value })} />
            <button type="submit" className="primary-button">Save</button>
          </form>
        )}
        {entry.unsupported && !entry.installed && <p className="plugin-unsupported">{entry.unsupported}</p>}
        {busy && (
          <p className="plugin-busy">
            <Loader2 size={12} className="spin" /> {busy}
          </p>
        )}
      </div>
      <div className="plugin-actions">
        {!entry.installed && !entry.unsupported && (
          <button className="primary-button" disabled={busy !== null} onClick={onInstall}>
            <Download size={13} /> Install
          </button>
        )}
        {update && (
          <button className="primary-button" disabled={busy !== null} onClick={onInstall} title={`Update to ${entry.version}`}>
            <RefreshCw size={13} /> Update
          </button>
        )}
        {entry.installed && !system && (
          <button className="icon-button" title="Remove" disabled={busy !== null} onClick={onRemove}>
            <Trash2 size={13} />
          </button>
        )}
        {entry.installed && !update && <Check size={14} className="plugin-installed" />}
      </div>
    </div>
  )
}
