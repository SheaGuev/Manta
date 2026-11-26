export interface CellSize {
  width: number
  height: number
}

export interface TerminalSize {
  cols: number
  rows: number
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined
}

/**
 * The cell size xterm draws with, in CSS pixels, or null before it has measured a character. The public
 * API has no cell size, so this reads xterm's render state: the value `FitAddon` reads too.
 *
 * Dividing the drawn `.xterm-screen` by the terminal's rows and columns instead goes wrong after a resize
 * while the terminal is hidden: xterm defers the renderer's resize until it's visible, so the drawn size
 * still belongs to the old rows and columns, and the next fit comes out far too large.
 */
export function cellSize(term: unknown): CellSize | null {
  const cell = ['_core', '_renderService', 'dimensions', 'css', 'cell'].reduce(field, term)
  const width = field(cell, 'width')
  const height = field(cell, 'height')
  if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) return null
  return { width, height }
}

/** The columns and rows that fit a content box of `width` by `height` CSS pixels. */
export function fitSize(width: number, height: number, cell: CellSize): TerminalSize {
  return { cols: Math.max(2, Math.floor(width / cell.width)), rows: Math.max(1, Math.floor(height / cell.height)) }
}
