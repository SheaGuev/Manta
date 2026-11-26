import { describe, expect, it } from 'vitest'
import { parseTable, tokenizeInline } from '../markdownTable'

describe('parseTable', () => {
  it('splits header and rows, skipping the delimiter row', () => {
    expect(parseTable('| Code | Feature |\n|---|---|\n| F1 | Native \\| Rust |\n| F2 | Agents |\n')).toEqual({
      header: ['Code', 'Feature'],
      rows: [
        ['F1', 'Native | Rust'],
        ['F2', 'Agents']
      ]
    })
  })
})

describe('tokenizeInline', () => {
  it('recognises code, bold, italic and links', () => {
    expect(tokenizeInline('Use `deltadb` for **sync**, see [docs](https://x) _now_')).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'code', text: 'deltadb' },
      { kind: 'text', text: ' for ' },
      { kind: 'strong', text: 'sync' },
      { kind: 'text', text: ', see ' },
      { kind: 'link', text: 'docs' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'now' }
    ])
  })
})
