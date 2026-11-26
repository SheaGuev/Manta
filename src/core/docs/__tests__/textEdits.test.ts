import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyTextEdits, changedRanges, computeTextEdits, mergeTexts } from '../textEdits'

function edit(before: string, after: string): Y.Text {
  const doc = new Y.Doc()
  const text = doc.getText('md')
  text.insert(0, before)
  doc.transact(() => applyTextEdits(text, computeTextEdits(before, after)))
  return text
}

describe('computeTextEdits', () => {
  it.each([
    ['', 'hello\n'],
    ['hello\n', ''],
    ['a\nb\nc\n', 'a\nB\nc\n'],
    ['# Title\n\nbody\n', '# New title\n\n> note\n\nbody text\n'],
    ['no trailing newline', 'no trailing newline\n'],
    ['line\r\nline\r\n', 'line\r\nchanged\r\n']
  ])('turns %j into %j', (before, after) => {
    expect(edit(before, after).toString()).toBe(after)
  })

  it('keeps unchanged characters on an edited line', () => {
    const before = 'Sessions last 30 days.\n'
    const edits = computeTextEdits(before, 'Sessions last 30 days, then refresh.\n')
    expect(edits[0]).toEqual({ kind: 'retain', length: 'Sessions last 30 days'.length })
  })

  it('keeps an anchor inside an edited line attached', () => {
    const before = 'intro\nSessions last 30 days.\noutro\n'
    const doc = new Y.Doc()
    const text = doc.getText('md')
    text.insert(0, before)
    const anchor = Y.createRelativePositionFromTypeIndex(text, before.indexOf('30'))

    doc.transact(() => applyTextEdits(text, computeTextEdits(before, 'new intro\nSessions last 30 days, then refresh.\noutro\n')))

    const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, doc)
    expect(text.toString().slice(resolved?.index, (resolved?.index ?? 0) + 2)).toBe('30')
  })
})

describe('changedRanges', () => {
  it('reports each hunk as an inserted span of the new text plus what it replaced', () => {
    const before = 'Sessions last 30 days.\n\nNone yet.\n'
    const after = 'Sessions last 14 days, then refresh.\n\nNone yet.\nAsk security.\n'
    const ranges = changedRanges(before, after)
    expect(ranges.map(({ from, to, removed }) => ({ inserted: after.slice(from, to), removed }))).toEqual([
      { inserted: '14', removed: '30' },
      { inserted: ', then refresh', removed: '' },
      { inserted: 'Ask security.\n', removed: '' }
    ])
  })

  it('reports a pure deletion as an empty span at the deletion point', () => {
    expect(changedRanges('keep drop keep', 'keep keep')).toEqual([{ from: 5, to: 5, removed: 'drop ' }])
    expect(changedRanges('same', 'same')).toEqual([])
  })
})

describe('mergeTexts', () => {
  const base = '# Map\n\nIntro.\n\n## Docs\n\n- [a](a.md)\n'

  it('keeps edits each side made to different parts', () => {
    const ours = base.replace('Intro.', 'Intro, edited by hand.')
    const theirs = base.replace('- [a](a.md)\n', '- [a](a.md)\n- [b](b.md)\n')
    expect(mergeTexts(base, ours, theirs)).toBe('# Map\n\nIntro, edited by hand.\n\n## Docs\n\n- [a](a.md)\n- [b](b.md)\n')
  })

  it('takes the side that changed when the other did not', () => {
    expect(mergeTexts(base, base, 'theirs')).toBe('theirs')
    expect(mergeTexts(base, 'ours', base)).toBe('ours')
    expect(mergeTexts(base, 'same', 'same')).toBe('same')
  })
})
