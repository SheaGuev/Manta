import { getChunks, unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { ReviewComment } from '../../../../shared/ipc'
import { deletedRowAnchor, deletedRowCount, inRanges, newLineAnchor, placeComments, placeThreads, lineToReveal, type ThreadNote } from '../reviewAnchors'

/** b becomes B (a changed chunk: deleted `b`, inserted `B`) and `e` is added. */
const state = EditorState.create({ doc: 'a\nB\nc\nd\ne\n', extensions: [unifiedMergeView({ original: 'a\nb\nc\nd\n' })] })
const changed = getChunks(state)?.chunks[0]

const comment = (extra: Partial<ReviewComment>): ReviewComment => ({
  id: 'rc_000000000001',
  relPath: 'src/a.ts',
  diff: 'branch',
  side: 'new',
  line: 5,
  lineText: 'e',
  hunk: '',
  body: 'note',
  createdAt: '2026-10-28T00:00:00.000Z',
  sent: null,
  ...extra
})

describe('newLineAnchor', () => {
  it('anchors to the line with two rows of the unified diff either side', () => {
    expect(newLineAnchor(state, 2)).toEqual({ side: 'new', line: 2, lineText: 'B', hunk: ' a\n-b\n+B\n c\n d' })
  })

  it("marks added lines and stops at the file's last line, not the empty one after its final newline", () => {
    expect(newLineAnchor(state, 5)).toEqual({ side: 'new', line: 5, lineText: 'e', hunk: ' c\n d\n+e' })
  })
})

describe('deletedRowAnchor', () => {
  it("anchors a deleted row to the old side's line and text", () => {
    const anchor = deletedRowAnchor(state, changed?.fromB ?? -1, 0)
    expect(anchor).toMatchObject({ side: 'old', line: 2, lineText: 'b' })
    expect(anchor?.hunk).toBe(' a\n-b\n+B\n c')
  })

  it('is null for a row past the deleted lines, or no chunk there', () => {
    expect(deletedRowAnchor(state, changed?.fromB ?? -1, 1)).toBeNull()
    expect(deletedRowAnchor(state, 0, 0)).toBeNull()
  })
})

describe('deletedRowCount', () => {
  it('counts the deleted lines drawn at a position, and is 0 where none are', () => {
    expect(deletedRowCount(state, changed?.fromB ?? -1)).toBe(1)
    expect(deletedRowCount(state, getChunks(state)?.chunks[1]?.fromB ?? -1)).toBe(0)
    expect(deletedRowCount(state, 0)).toBe(0)
  })
})

describe('placeComments', () => {
  it('puts a new-side comment at the end of its line', () => {
    expect(placeComments(state, [comment({})])).toEqual([{ comment: comment({}), pos: state.doc.line(5).to, before: false, outdated: false }])
  })

  it("marks a comment outdated when its line's text changed", () => {
    expect(placeComments(state, [comment({ lineText: 'x' })])[0]).toMatchObject({ pos: state.doc.line(5).to, outdated: true })
  })

  it('puts an old-side comment after its deleted rows, before the line there', () => {
    const old = comment({ side: 'old', line: 2, lineText: 'b' })
    expect(placeComments(state, [old])[0]).toEqual({ comment: old, pos: changed?.fromB, before: true, outdated: false })
  })

  it('keeps a comment whose line is gone, outdated, on the nearest line', () => {
    expect(placeComments(state, [comment({ line: 99 })])[0]).toMatchObject({ pos: state.doc.length, before: false, outdated: true })
    const old = comment({ side: 'old', line: 3, lineText: 'c' })
    expect(placeComments(state, [old])[0]).toMatchObject({ pos: state.doc.line(3).to, before: false, outdated: true })
  })
})

describe('lineToReveal', () => {
  it("is a new-side line itself, and for an old-side one the current line its deleted rows sit above", () => {
    /** Two lines added at the top move the changed `d` (old line 4) down to current line 6. */
    const moved = EditorState.create({ doc: 'x\ny\na\nb\nc\nD\ne\n', extensions: [unifiedMergeView({ original: 'a\nb\nc\nd\ne\n' })] })
    expect(lineToReveal(moved, 'new', 4)).toBe(4)
    expect(lineToReveal(moved, 'old', 4)).toBe(6)
    expect(lineToReveal(moved, 'new', 99)).toBe(moved.doc.lines)
  })
})

const note = (extra: Partial<ThreadNote>): ThreadNote => ({ id: 't1', side: 'new', line: 5, author: 'dave', body: 'Why?', replies: 0, url: 'u', ...extra })

describe('placeThreads', () => {
  it('places a new-side thread under its line and an old-side one under its deleted row', () => {
    expect(placeThreads(state, [note({})])).toEqual([{ note: note({}), pos: state.doc.line(5).to, before: false }])
    const old = note({ id: 't2', side: 'old', line: 2 })
    expect(placeThreads(state, [old])).toEqual([{ note: old, pos: changed?.fromB, before: true }])
  })

  it('places an old-side thread on an unchanged line under that line in the current file', () => {
    /** `bb` became `B` (one character shorter), then two lines were inserted before `d`. */
    const shifted = EditorState.create({ doc: 'a\nB\nc\nx\ny\nd\n', extensions: [unifiedMergeView({ original: 'a\nbb\nc\nd\n' })] })
    const old = note({ side: 'old', line: 4 })
    expect(placeThreads(shifted, [old])).toEqual([{ note: old, pos: shifted.doc.line(6).to, before: false }])
  })

  it('drops a thread whose line is past the end of the file', () => {
    expect(placeThreads(state, [note({ line: 40 }), note({ side: 'old', line: 40 }), note({ line: 0 })])).toEqual([])
  })
})

describe('inRanges', () => {
  it('tells whether a line is inside any range', () => {
    const ranges: [number, number][] = [
      [3, 5],
      [10, 10]
    ]
    expect([2, 3, 5, 6, 10, 11].map((line) => inRanges(ranges, line))).toEqual([false, true, true, false, true, false])
    expect(inRanges([], 1)).toBe(false)
  })
})
