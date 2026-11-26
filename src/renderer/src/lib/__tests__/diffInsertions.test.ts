import { Chunk } from '@codemirror/merge'
import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { insertedOnlyLines } from '../diffInsertions'

const doc = (text: string): Text => Text.of(text.split('\n'))
const lineNumbers = (before: string, after: string): number[] => {
  const b = doc(after)
  return insertedOnlyLines(Chunk.build(doc(before), b), b).map((from) => b.lineAt(from).number)
}

describe('insertedOnlyLines', () => {
  it('covers every line of a new file', () => {
    expect(lineNumbers('', 'one\ntwo\nthree\n')).toEqual([1, 2, 3])
  })

  it('covers a block added to an existing file, and nothing else', () => {
    expect(lineNumbers('a\nb\nc\n', 'a\nnew 1\nnew 2\nb\nc\n')).toEqual([2, 3])
  })

  it('leaves edited lines alone, so their changed words still show', () => {
    expect(lineNumbers('a\nb\nc\n', 'a\nB edited\nc\n')).toEqual([])
  })

  it('leaves deletions alone', () => {
    expect(lineNumbers('a\nb\nc\n', 'a\nc\n')).toEqual([])
  })
})
