import { describe, expect, it } from 'vitest'
import { editOffsets, editsByUri, type TextEdit } from '../workspaceEdits'

const edit = (line: number, from: number, to: number, newText: string, endLine = line): TextEdit => ({
  range: { start: { line, character: from }, end: { line: endLine, character: to } },
  newText
})

function apply(text: string, edits: TextEdit[]): string {
  let result = text
  for (const { from, to, insert } of editOffsets(text, edits)) result = result.slice(0, from) + insert + result.slice(to)
  return result
}

describe('editOffsets', () => {
  it('applies several edits on one line without shifting each other', () => {
    expect(apply('greet(greet)\n', [edit(0, 0, 5, 'hello'), edit(0, 6, 11, 'hello')])).toBe('hello(hello)\n')
  })

  it('handles edits on later lines and across lines', () => {
    expect(apply('a\nb\nc\n', [edit(1, 0, 1, 'B'), edit(0, 1, 0, '', 2)])).toBe('ac\n')
  })

  it('clamps positions past the end of a line or the file', () => {
    expect(apply('ab\n', [edit(0, 1, 99, 'X')])).toBe('aX\n')
    expect(apply('ab', [edit(9, 0, 0, '!')])).toBe('ab!')
  })

  it('drops the later of two overlapping edits', () => {
    expect(apply('abcdef', [edit(0, 0, 4, 'X'), edit(0, 2, 5, 'Y')])).toBe('Xef')
  })

  it('returns nothing for no edits', () => {
    expect(editOffsets('abc', [])).toEqual([])
  })
})

describe('editsByUri', () => {
  it('reads `changes`', () => {
    const byUri = editsByUri({ changes: { 'file:///a.ts': [edit(0, 0, 1, 'x')] } })
    expect([...byUri.keys()]).toEqual(['file:///a.ts'])
  })

  it('reads text edits from `documentChanges` and skips file operations', () => {
    const byUri = editsByUri({
      documentChanges: [{ textDocument: { uri: 'file:///b.ts', version: 1 }, edits: [edit(0, 0, 1, 'y')] }, { kind: 'rename', oldUri: 'file:///c.ts', newUri: 'file:///d.ts' }]
    })
    expect([...byUri.entries()]).toEqual([['file:///b.ts', [edit(0, 0, 1, 'y')]]])
  })

  it('is empty for no edit at all', () => {
    expect(editsByUri(null).size).toBe(0)
  })
})
