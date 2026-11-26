import { LogIn, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeCodeStatus } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'

const api = window.manta

const PROVIDERS: Record<string, string> = { firstParty: 'Anthropic', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry' }

/** Status bar item for the Claude Code that thread agents run: installed, signed in, through what. */
export function ClaudeStatus(): React.JSX.Element {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'checking' | 'signing-in' | null>('checking')
  const anchor = useRef<HTMLDivElement>(null)

  const check = useCallback(() => {
    setBusy('checking')
    api
      .claudeStatus()
      .then(setStatus)
      .catch((error: unknown) => setStatus(failed(error)))
      .finally(() => setBusy(null))
  }, [])

  useEffect(check, [check])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const signIn = (): void => {
    setBusy('signing-in')
    api
      .claudeSignIn()
      .then(setStatus)
      .catch((error: unknown) => setStatus(failed(error)))
      .finally(() => setBusy(null))
  }

  const ready = status !== null && status.path !== null && status.loggedIn && !status.error
  const state = status === null ? 'pending' : ready ? 'ready' : 'attention'

  return (
    <div className="popover-anchor" ref={anchor}>
      <button
        className={`icon-button claude-status ${open ? 'active' : ''}`}
        title="Claude Code, which runs thread agents"
        onClick={() => {
          setOpen((o) => !o)
          if (!open) check()
        }}
      >
        <span className={`claude-dot ${state}`} /> Claude Code
      </button>
      {open && (
        <div className="popover claude-popover">
          <div className="claude-rows">
            <span className="muted-row">Executable</span>
            <span>
              {status?.path ? (
                <>
                  <code>{status.path}</code>
                  {status.version && ` (${status.version})`}
                </>
              ) : (
                'Not found on your PATH. Threads use the copy bundled with Manta.'
              )}
            </span>
            <span className="muted-row">Signed in</span>
            <span>
              {busy === 'checking'
                ? 'Checking…'
                : status?.loggedIn
                  ? `Yes, through ${providerName(status)}`
                  : 'No'}
            </span>
          </div>
          {status?.error && <div className="hint error-hint">{status.error}</div>}
          <div className="button-row">
            <button className="primary-button" disabled={busy !== null} onClick={check}>
              <RefreshCw size={13} /> Check again
            </button>
            {status?.path && !status.loggedIn && (
              <button className="primary-button accent" disabled={busy !== null} onClick={signIn}>
                <LogIn size={13} /> {busy === 'signing-in' ? 'Finish in your browser…' : 'Sign in'}
              </button>
            )}
          </div>
          <span className="hint">
            Thread agents run this Claude Code on your own account, limited to each thread's folder.
          </span>
        </div>
      )}
    </div>
  )
}

function providerName(status: ClaudeCodeStatus): string {
  const named = status.apiProvider ? PROVIDERS[status.apiProvider] : undefined
  return named ?? status.apiProvider ?? status.authMethod ?? 'an unknown provider'
}

function failed(error: unknown): ClaudeCodeStatus {
  return { path: null, version: null, loggedIn: false, authMethod: null, apiProvider: null, error: withoutIpcPrefix(error instanceof Error ? error.message : String(error)) }
}
