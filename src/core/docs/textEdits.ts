import DiffMatchPatch from 'diff-match-patch'
import * as Y from 'yjs'
import type { Snapshot } from './docStore'

export type TextEdit =
  | { kind: 'retain'; length: number }
  | { kind: 'delete'; length: number }
  | { kind: 'insert'; text: string }

const dmp = new DiffMatchPatch()

/**
 * Minimal edits turning `before` into `after`. Line diff first to find changed hunks,
 * then a character diff inside each hunk, so unchanged characters on an edited line keep
 * their CRDT identity and anchors on them survive.
 */
export function computeTextEdits(before: string, after: string): TextEdit[] {
  const lines = dmp.diff_linesToChars_(before, after)
  const lineDiffs = dmp.diff_main(lines.chars1, lines.chars2, false)
  dmp.diff_charsToLines_(lineDiffs, lines.lineArray)

  const edits: TextEdit[] = []
  let pendingDelete = ''
  let pendingInsert = ''

  const flushHunk = (): void => {
    if (pendingDelete && pendingInsert) {
      const charDiffs = dmp.diff_main(pendingDelete, pendingInsert)
      dmp.diff_cleanupSemantic(charDiffs)
      for (const [op, text] of charDiffs) pushEdit(edits, op, text)
    } else if (pendingDelete) {
      pushEdit(edits, DiffMatchPatch.DIFF_DELETE, pendingDelete)
    } else if (pendingInsert) {
      pushEdit(edits, DiffMatchPatch.DIFF_INSERT, pendingInsert)
    }
    pendingDelete = ''
    pendingInsert = ''
  }

  for (const [op, text] of lineDiffs) {
    if (op === DiffMatchPatch.DIFF_DELETE) pendingDelete += text
    else if (op === DiffMatchPatch.DIFF_INSERT) pendingInsert += text
    else {
      flushHunk()
      pushEdit(edits, op, text)
    }
  }
  flushHunk()
  return edits
}

function pushEdit(edits: TextEdit[], op: number, text: string): void {
  if (text.length === 0) return
  if (op === DiffMatchPatch.DIFF_EQUAL) edits.push({ kind: 'retain', length: text.length })
  else if (op === DiffMatchPatch.DIFF_DELETE) edits.push({ kind: 'delete', length: text.length })
  else edits.push({ kind: 'insert', text })
}

/** Applies edits to a Y.Text. Must run inside a transaction for the edits to land as one update. */
export function applyTextEdits(ytext: Y.Text, edits: readonly TextEdit[]): void {
  let index = 0
  for (const edit of edits) {
    if (edit.kind === 'retain') index += edit.length
    else if (edit.kind === 'delete') ytext.delete(index, edit.length)
    else {
      ytext.insert(index, edit.text)
      index += edit.text.length
    }
  }
}

/** One changed stretch: `from..to` is what was inserted (in the new text), `removed` what it replaced. */
export interface ChangedRange {
  from: number
  to: number
  removed: string
}

/** The hunks turning `before` into `after`, as spans of `after` plus the text each one replaced. */
export function changedRanges(before: string, after: string): ChangedRange[] {
  const ranges: ChangedRange[] = []
  let current: ChangedRange | null = null
  let at = 0
  let beforeAt = 0
  for (const edit of computeTextEdits(before, after)) {
    if (edit.kind === 'retain') {
      if (current) ranges.push(current)
      current = null
      at += edit.length
      beforeAt += edit.length
    } else if (edit.kind === 'delete') {
      current ??= { from: at, to: at, removed: '' }
      current.removed += before.slice(beforeAt, beforeAt + edit.length)
      beforeAt += edit.length
    } else {
      current ??= { from: at, to: at, removed: '' }
      at += edit.text.length
      current.to = at
    }
  }
  if (current) ranges.push(current)
  return ranges
}

/**
 * Brings `target` to `newText` as if the change had been made at `base`: forks the CRDT at
 * `base`, replays `base.text → newText` as minimal ops, and merges the fork in. Edits `target`
 * received since `base` survive as concurrent edits. Returns the fork's full state.
 */
export function mergeTextChange(target: Y.Doc, base: Snapshot, newText: string, actor: string, origin: unknown): Uint8Array {
  const fork = new Y.Doc()
  Y.applyUpdate(fork, base.state)
  const forkText = fork.getText('md')
  if (forkText.toString() !== base.text) throw new Error('Stored snapshot does not match its recorded text')
  fork.transact(() => {
    applyTextEdits(forkText, computeTextEdits(base.text, newText))
    fork.getMap<string>('actors').set(String(fork.clientID), actor)
  })
  Y.applyUpdate(target, Y.encodeStateAsUpdate(fork, Y.encodeStateVector(target)), origin)
  return Y.encodeStateAsUpdate(fork)
}

/**
 * Three-way merge through the CRDT: `base → ours` and `base → theirs` are replayed as minimal ops on
 * two copies of `base` and merged, so edits to different parts both survive.
 */
export function mergeTexts(base: string, ours: string, theirs: string): string {
  if (ours === base || ours === theirs) return theirs
  if (theirs === base) return ours
  const root = new Y.Doc()
  root.getText('md').insert(0, base)
  const state = Y.encodeStateAsUpdate(root)
  const copy = (text: string): Y.Doc => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    doc.transact(() => applyTextEdits(doc.getText('md'), computeTextEdits(base, text)))
    return doc
  }
  const merged = copy(ours)
  const other = copy(theirs)
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(other, Y.encodeStateVector(merged)))
  return merged.getText('md').toString()
}
