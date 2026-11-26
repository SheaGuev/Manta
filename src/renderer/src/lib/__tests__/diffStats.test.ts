import { describe, expect, it } from 'vitest'
import { changedLines, diffLineCounts } from '../diffStats'

const DOC = '# Auth\n\n## Sessions\n\nSessions last 30 days.\n'

describe('diffLineCounts', () => {
  it('counts a changed line as one removed and one added', () => {
    expect(diffLineCounts(DOC, DOC.replace('30 days.', '14 days, then refresh.'))).toEqual({ added: 1, removed: 1 })
  })

  it('counts pure insertions and deletions', () => {
    expect(diffLineCounts(DOC, `${DOC}\nRefresh silently.\nKeep a log.\n`)).toEqual({ added: 3, removed: 0 })
    expect(diffLineCounts(DOC, DOC.replace('\nSessions last 30 days.\n', ''))).toEqual({ added: 0, removed: 2 })
  })

  it('is zero for identical text', () => {
    expect(diffLineCounts(DOC, DOC)).toEqual({ added: 0, removed: 0 })
    expect(diffLineCounts('', '')).toEqual({ added: 0, removed: 0 })
  })
})

describe('changedLines', () => {
  it('gives the lines between what two texts share at their start and end', () => {
    expect(changedLines('# Auth\n\nSessions last 30 days.\n', '# Auth\n\nSessions last 7 days.\nTokens rotate.\n')).toEqual({ removed: ['Sessions last 30 days.'], added: ['Sessions last 7 days.', 'Tokens rotate.'] })
    expect(changedLines('a\nb', 'a\nb')).toBeNull()
    expect(changedLines('a', 'a\nb')).toEqual({ removed: [], added: ['b'] })
  })
})
