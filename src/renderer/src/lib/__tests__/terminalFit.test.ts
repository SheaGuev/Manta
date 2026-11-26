import { describe, expect, it } from 'vitest'
import { cellSize, fitSize } from '../terminalFit'

const terminal = (cell: unknown) => ({ _core: { _renderService: { dimensions: { css: { cell } } } } })

describe('cellSize', () => {
  it("reads the cell size xterm draws with", () => {
    expect(cellSize(terminal({ width: 7.5, height: 17 }))).toEqual({ width: 7.5, height: 17 })
  })

  it('is null before xterm has measured a character, as when opened in a hidden tab', () => {
    expect(cellSize(terminal({ width: 0, height: 0 }))).toBeNull()
  })

  it('is null when xterm no longer has that render state', () => {
    expect(cellSize({})).toBeNull()
    expect(cellSize(terminal({ width: '7.5', height: 17 }))).toBeNull()
    expect(cellSize(terminal({ width: Number.NaN, height: 17 }))).toBeNull()
  })
})

describe('fitSize', () => {
  it('counts whole cells in the content box', () => {
    expect(fitSize(758, 719, { width: 7.5, height: 17 })).toEqual({ cols: 101, rows: 42 })
  })

  it('keeps a minimum of 2 columns and 1 row', () => {
    expect(fitSize(1, 1, { width: 7.5, height: 17 })).toEqual({ cols: 2, rows: 1 })
  })
})
