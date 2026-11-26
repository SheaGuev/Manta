import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  icon: React.ReactNode
  onSelect: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: readonly MenuItem[]
  onClose: () => void
}

/** A right-click menu at the pointer. Closes on a click outside it, Escape, or the window losing focus. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  return (
    <div className="context-menu" ref={menu} style={{ left: x, top: y }}>
      {items.map((item) => (
        <button
          key={item.label}
          className="context-menu-item"
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
