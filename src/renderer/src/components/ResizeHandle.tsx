import { useRef } from 'react'

interface ResizeHandleProps {
  /** The pane edge the handle sits on; dragging away from the pane widens it. */
  edge: 'left' | 'right'
  width: number
  onResize: (width: number) => void
  onReset: () => void
}

/** A draggable pane edge. Double-click restores the default width. */
export function ResizeHandle({ edge, width, onResize, onReset }: ResizeHandleProps): React.JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null)
  return (
    <div
      className={`resize-handle ${edge}`}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, width }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const dx = e.clientX - drag.current.x
        onResize(drag.current.width + (edge === 'right' ? dx : -dx))
      }}
      /** Fires after pointerup and after pointercancel, so one handler ends every drag. */
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onDoubleClick={onReset}
    />
  )
}
