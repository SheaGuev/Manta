import { ArrowDownToLine, Braces, GitBranch, GitCommitHorizontal, RotateCcw } from 'lucide-react'
import type { LanguageServerStatus } from '../../../shared/ipc'
import { useLanguageServers, useRepoStatus } from '../lib/hooks'
import { restartServer } from '../lib/lsp/clients'
import { ClaudeStatus } from './ClaudeStatus'

export interface StatusMessage {
  text: string
  error: boolean
}

interface StatusBarProps {
  root: string | null
  label: string | null
  message: StatusMessage | null
  /** Opens the Changes tab with the commit message focused. */
  onCommit: () => void
  onPull: () => void
}

/** Delta-style footer: where you are, what changed, and the git actions for it. */
export function StatusBar({ root, label, message, onCommit, onPull }: StatusBarProps): React.JSX.Element {
  const status = useRepoStatus(root)

  return (
    <footer className="statusbar">
      {root && label && (
        <>
          <span className="item">
            <GitBranch size={12} />
            {label}
          </span>
          {status && (
            <>
              <span className="item">
                <span className="sep">/</span>
                {status.branch || 'no branch'}
              </span>
              {(status.added > 0 || status.removed > 0) && (
                <span className="item">
                  <span className="add">+{status.added}</span>
                  <span className="del">−{status.removed}</span>
                </span>
              )}
            </>
          )}
        </>
      )}
      <span className="grow" />
      {message && <span className={`message ${message.error ? 'error' : ''}`}>{message.text}</span>}
      {root && <LanguageServers root={root} />}
      <ClaudeStatus />
      {root && (
        <>
          <button className="icon-button" onClick={onPull} title="Fetch and fast-forward from upstream">
            <ArrowDownToLine size={13} /> Pull
          </button>
          <button className="icon-button" onClick={onCommit} title="Write a message and commit in the Changes tab">
            <GitCommitHorizontal size={13} /> Commit
          </button>
        </>
      )}
    </footer>
  )
}

const STATE_LABEL: Record<LanguageServerStatus['state'], string> = { starting: 'starting…', ready: '', crashed: 'crashed', stopped: '' }

/** The context's language servers: starting, ready, or crashed with the reason and a Restart button. */
function LanguageServers({ root }: { root: string }): React.JSX.Element | null {
  const servers = useLanguageServers().filter((server) => server.root === root)
  if (servers.length === 0) return null
  return (
    <>
      {servers.map((server) => (
        <span key={server.server} className={`item language-server state-${server.state}`} title={server.message ?? `${server.name} language server`}>
          <Braces size={12} />
          {server.name}
          {STATE_LABEL[server.state] && <span className="muted">{STATE_LABEL[server.state]}</span>}
          {server.state === 'crashed' && (
            <button
              className="icon-button"
              title={server.canRestart ? 'Restart the language server' : `${server.name} keeps crashing; restart it anyway`}
              onClick={() => void restartServer(server).catch((error: unknown) => console.warn('manta: restart language server', error))}
            >
              <RotateCcw size={12} /> Restart
            </button>
          )}
        </span>
      ))}
    </>
  )
}

