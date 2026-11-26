import { Bot, Plus, Puzzle, Settings2, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import type { OpResult } from '../../../shared/ipc'
import { ClaudeCommandDialog } from './ClaudeCommandDialog'
import { ContextMenu } from './ContextMenu'

interface NewTabButtonProps {
  onNewClaude: () => void
  onNewShell: () => void
  /** Opens the Plugins view: language servers, linters, formatters, editor themes. */
  onPlugins: () => void
  onResult: (result: OpResult) => void
}

/** The + after the last tab: a new Claude session or shell in this context, or the Claude command they start with. */
export function NewTabButton({ onNewClaude, onNewShell, onPlugins, onResult }: NewTabButtonProps): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState(false)
  return (
    <>
      <button
        className={`icon-button new-tab ${menu ? 'active' : ''}`}
        title="New tab"
        /** Stops the open menu's outside-click handler, so a second click closes it instead of reopening it. */
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          setMenu((open) => (open ? null : { x: box.left, y: box.bottom + 4 }))
        }}
      >
        <Plus size={14} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'New Claude session', icon: <Bot size={14} />, onSelect: onNewClaude },
            { label: 'New shell', icon: <SquareTerminal size={14} />, onSelect: onNewShell },
            { label: 'Claude command…', icon: <Settings2 size={14} />, onSelect: () => setEditing(true) },
            { label: 'Plugins', icon: <Puzzle size={14} />, onSelect: onPlugins }
          ]}
        />
      )}
      {editing && (
        <ClaudeCommandDialog
          onClose={() => setEditing(false)}
          onSaved={(result) => {
            setEditing(false)
            onResult(result)
          }}
        />
      )}
    </>
  )
}
