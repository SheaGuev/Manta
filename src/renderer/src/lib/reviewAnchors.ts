import { getChunks, getOriginalDoc } from '@codemirror/merge'
import type { EditorState, Text } from '@codemirror/state'
import type { ReviewAnchor, ReviewComment } from '../../../shared/ipc'

export type LineAnchor = Omit<ReviewAnchor, 'relPath' | 'diff'>

/** Rows of the unified diff either side of a comment's row in its hunk. */
const CONTEXT_ROWS = 2

/** One row of the unified diff as the view shows it: a current line, or a deleted line drawn above it. */
interface Row {
  prefix: '+' | '-' | ' '
  text: string
  /** The current line's number, or the deleted line's number on the old side. */
  line: number
}

export function newLineAnchor(state: EditorState, lineNumber: number): LineAnchor {
  const rows = unifiedRows(state)
  const at = rows.findIndex((row) => row.prefix !== '-' && row.line === lineNumber)
  return { side: 'new', line: lineNumber, lineText: state.doc.line(lineNumber).text, hunk: hunkAround(rows, at) }
}

/** The old side's line number of a deleted row; null when there's no such row. */
export function deletedRowLine(state: EditorState, chunkFromB: number, row: number): number | null {
  const original = getOriginalDoc(state)
  const chunk = getChunks(state)?.chunks.find((c) => c.fromB === chunkFromB)
  if (!chunk || row < 0 || row >= deletedLines(chunk, original).length) return null
  return original.lineAt(chunk.fromA).number + row
}

/** `row` counts the deleted lines drawn at `chunkFromB`; null when there are none there or it's past them. */
export function deletedRowAnchor(state: EditorState, chunkFromB: number, row: number): LineAnchor | null {
  const line = deletedRowLine(state, chunkFromB, row)
  if (line === null) return null
  const original = getOriginalDoc(state)
  const rows = unifiedRows(state)
  const at = rows.findIndex((r) => r.prefix === '-' && r.line === line)
  return { side: 'old', line, lineText: original.line(line).text, hunk: hunkAround(rows, at) }
}

/** How many deleted lines the deletion widget at `chunkFromB` draws; 0 when there's none there. */
export function deletedRowCount(state: EditorState, chunkFromB: number): number {
  const chunk = getChunks(state)?.chunks.find((c) => c.fromB === chunkFromB)
  return chunk ? deletedLines(chunk, getOriginalDoc(state)).length : 0
}

/** The current line to scroll to for a line of one side: an old-side line shows above the line its deletion sits on. */
export function lineToReveal(state: EditorState, side: 'old' | 'new', line: number): number {
  const doc = state.doc
  const clamp = (n: number): number => Math.min(Math.max(n, 1), doc.lines)
  if (side === 'new') return clamp(line)
  const original = getOriginalDoc(state)
  const start = line >= 1 && line <= original.lines ? original.line(line).from : -1
  const chunk = getChunks(state)?.chunks.find((c) => c.toA > c.fromA && start >= c.fromA && start < c.toA)
  return chunk ? doc.lineAt(Math.min(chunk.fromB, doc.length)).number : clamp(line)
}

export interface PlacedComment {
  comment: ReviewComment
  pos: number
  /** True for a comment drawn before the line at `pos` (after a deletion's rows); otherwise it's drawn after the line. */
  before: boolean
  /** The line's text no longer matches, or the line is gone; it's shown at the nearest line. */
  outdated: boolean
}

export function placeComments(state: EditorState, comments: readonly ReviewComment[]): PlacedComment[] {
  const doc = state.doc
  const original = getOriginalDoc(state)
  const chunks = getChunks(state)?.chunks ?? []
  const nearest = (line: number): number => doc.line(Math.min(Math.max(line, 1), doc.lines)).to
  return comments.map((comment) => {
    if (comment.side === 'new') {
      const exists = comment.line >= 1 && comment.line <= doc.lines
      const outdated = !exists || doc.line(comment.line).text !== comment.lineText
      return { comment, pos: nearest(comment.line), before: false, outdated }
    }
    const start = comment.line >= 1 && comment.line <= original.lines ? original.line(comment.line).from : -1
    const chunk = chunks.find((c) => c.toA > c.fromA && start >= c.fromA && start < c.toA)
    if (!chunk) return { comment, pos: nearest(comment.line), before: false, outdated: true }
    return { comment, pos: chunk.fromB, before: true, outdated: original.line(comment.line).text !== comment.lineText }
  })
}

export function inRanges(ranges: readonly (readonly [number, number])[], line: number): boolean {
  return ranges.some(([from, to]) => line >= from && line <= to)
}

/** An existing GitHub review thread to show, read-only, under its line. */
export interface ThreadNote {
  id: string
  side: 'old' | 'new'
  line: number
  author: string
  body: string
  replies: number
  url: string
}

/**
 * Where GitHub's threads go in the unified view: a new-side one under its line; an old-side one under
 * its deleted row, or, on a line both sides share, under that line. GitHub's line is trusted, so
 * there's no outdated check; a line past the file's end is dropped.
 */
export interface PlacedThread {
  note: ThreadNote
  pos: number
  before: boolean
}

export function placeThreads(state: EditorState, notes: readonly ThreadNote[]): PlacedThread[] {
  const doc = state.doc
  const original = getOriginalDoc(state)
  const chunks = getChunks(state)?.chunks ?? []
  return notes.flatMap((note): PlacedThread[] => {
    if (note.side === 'new') return note.line >= 1 && note.line <= doc.lines ? [{ note, pos: doc.line(note.line).to, before: false }] : []
    if (note.line < 1 || note.line > original.lines) return []
    const start = original.line(note.line).from
    const chunk = chunks.find((c) => c.toA > c.fromA && start >= c.fromA && start < c.toA)
    if (chunk) return [{ note, pos: chunk.fromB, before: true }]
    /** Unchanged text sits at the same offset once the chunks before it are allowed for. */
    const shift = chunks.filter((c) => c.endA <= start).reduce((sum, c) => sum + (c.endB - c.fromB) - (c.endA - c.fromA), 0)
    const pos = Math.min(start + shift, doc.length)
    return [{ note, pos: doc.lineAt(pos).to, before: false }]
  })
}

function hunkAround(rows: readonly Row[], at: number): string {
  return rows
    .slice(Math.max(0, at - CONTEXT_ROWS), at + CONTEXT_ROWS + 1)
    .map((row) => `${row.prefix}${row.text}`)
    .join('\n')
}

function deletedLines(chunk: { fromA: number; toA: number; endA: number }, original: Text): string[] {
  return chunk.toA > chunk.fromA ? original.sliceString(chunk.fromA, chunk.endA).split('\n') : []
}

/** The empty line CodeMirror has after a file's final newline isn't a line of the diff. */
function lastLine(doc: Text): number {
  return doc.lines > 1 && doc.line(doc.lines).length === 0 ? doc.lines - 1 : doc.lines
}

function unifiedRows(state: EditorState): Row[] {
  const doc = state.doc
  const original = getOriginalDoc(state)
  const chunks = getChunks(state)?.chunks ?? []
  const rows: Row[] = []
  let next = 0
  const deletionsUpTo = (pos: number): void => {
    for (; next < chunks.length && (chunks[next]?.fromB ?? Infinity) <= pos; next++) {
      const chunk = chunks[next]
      if (!chunk) continue
      const first = original.lineAt(chunk.fromA).number
      deletedLines(chunk, original).forEach((text, i) => rows.push({ prefix: '-', text, line: first + i }))
    }
  }
  for (let n = 1; n <= lastLine(doc); n++) {
    const line = doc.line(n)
    deletionsUpTo(line.from)
    const added = chunks.some((c) => c.toB > c.fromB && line.from >= c.fromB && line.from < c.toB)
    rows.push({ prefix: added ? '+' : ' ', text: line.text, line: n })
  }
  deletionsUpTo(Infinity)
  return rows
}
