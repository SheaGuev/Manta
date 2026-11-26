import { useEffect, useRef, useState } from 'react'
import type { ReviewTarget } from '../../../shared/ipc'
import { agentTargets, type AgentTarget } from '../lib/agentTargets'
import { useTerminals } from '../lib/hooks'

interface AgentPickerProps {
  /** The worktree the comments are from: its sessions come first, and a new session starts there. */
  root: string
  /** What it opens from, e.g. the send button; it sits below that, or above when there's no room. */
  anchorRect: DOMRect
  onPick: (target: ReviewTarget) => void
  onClose: () => void
  /** Shown under the rows, e.g. the PR tab's Edit prompt… link. */
  footer?: React.ReactNode
}

type Choice = { agent: AgentTarget } | { fresh: true }

const WIDTH = 300
/** Room for a handful of rows; above that it opens upwards. */
const ROOM_BELOW = 260

const folderName = (root: string): string => root.split('/').filter(Boolean).at(-1) ?? root

/** Which Claude session gets review comments: every open one, the worktree's own first, or a new one. */
export function AgentPicker({ root, anchorRect, onPick, onClose, footer }: AgentPickerProps): React.JSX.Element {
  const terminals = useTerminals()
  const choices: Choice[] = [...agentTargets(terminals ?? [], root).map((agent) => ({ agent })), { fresh: true }]
  const enabled = (choice: Choice | undefined): boolean => choice !== undefined && ('fresh' in choice || choice.agent.sendable)
  const [selected, setSelected] = useState<number | null>(null)
  const at = selected ?? Math.max(0, choices.findIndex(enabled))
  const popover = useRef<HTMLDivElement>(null)

  useEffect(() => {
    popover.current?.focus()
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && !popover.current?.contains(event.target)) onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose])

  const pick = (choice: Choice | undefined): void => {
    if (!choice || !enabled(choice)) return
    onPick('fresh' in choice ? { newSession: true } : { terminal: choice.agent.terminal.id })
  }

  const move = (delta: number): void => {
    for (let i = at + delta; i >= 0 && i < choices.length; i += delta) {
      if (enabled(choices[i])) return setSelected(i)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') move(1)
    else if (event.key === 'ArrowUp') move(-1)
    else if (event.key === 'Enter') pick(choices[at])
    else return
    event.preventDefault()
  }

  const below = anchorRect.bottom + ROOM_BELOW < window.innerHeight
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - WIDTH - 8))
  const place = below ? { top: anchorRect.bottom + 4, left } : { bottom: window.innerHeight - anchorRect.top + 4, left }

  return (
    <div className="popover quick-open agent-picker" style={place} ref={popover} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="agent-picker-title">Send to</div>
      <div className="quick-open-list">
        {choices.map((choice, index) => {
          const disabled = !enabled(choice)
          return (
            <div
              key={'fresh' in choice ? 'fresh' : choice.agent.terminal.id}
              className={`quick-open-row${index === at ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
              onMouseMove={() => !disabled && setSelected(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(choice)}
            >
              {'fresh' in choice ? (
                <span className="quick-open-name">New Claude session here</span>
              ) : (
                <>
                  <span className={`terminal-dot state-${choice.agent.terminal.state}`} />
                  <span className="quick-open-name">{choice.agent.terminal.title}</span>
                  <span className="quick-open-folder">{choice.agent.reason ?? folderName(choice.agent.terminal.root)}</span>
                </>
              )}
            </div>
          )
        })}
      </div>
      {footer && <div className="agent-picker-footer">{footer}</div>}
    </div>
  )
}
