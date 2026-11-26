import { describe, expect, it } from 'vitest'
import { fuzzyMatch, groupByFile, highlightParts, matchFileNames, parseQuickOpen, rankFiles, withRecentFirst } from '../search'

describe('matchFileNames', () => {
  const files = ['src/auth/login.ts', 'src/Auth.ts', 'README.md', 'docs/auth-flow.md']

  it('matches case-insensitively, file-name matches before folder-only matches', () => {
    expect(matchFileNames(files, 'AUTH', 10)).toEqual(['src/Auth.ts', 'docs/auth-flow.md', 'src/auth/login.ts'])
  })

  it('caps the results', () => {
    expect(matchFileNames(files, 'auth', 1)).toEqual(['src/Auth.ts'])
  })

  it('returns nothing when no path matches', () => {
    expect(matchFileNames(files, 'zzz', 10)).toEqual([])
  })
})

describe('groupByFile', () => {
  it('groups in first-seen order', () => {
    const a1 = { path: 'a', line: 1, text: 'x' }
    const b1 = { path: 'b', line: 4, text: 'x' }
    const a2 = { path: 'a', line: 9, text: 'x' }
    expect(groupByFile([a1, b1, a2])).toEqual([
      { path: 'a', matches: [a1, a2] },
      { path: 'b', matches: [b1] }
    ])
  })

  it('handles no matches', () => {
    expect(groupByFile([])).toEqual([])
  })
})

describe('highlightParts', () => {
  it('marks every case-insensitive occurrence, keeping the original casing', () => {
    expect(highlightParts('Token or TOKEN', 'token')).toEqual([
      { text: 'Token', match: true },
      { text: ' or ', match: false },
      { text: 'TOKEN', match: true }
    ])
  })

  it('returns the whole text when nothing matches or the query is empty', () => {
    expect(highlightParts('abc', 'z')).toEqual([{ text: 'abc', match: false }])
    expect(highlightParts('abc', '')).toEqual([{ text: 'abc', match: false }])
  })
})

describe('fuzzyMatch', () => {
  it('needs every query character, in order', () => {
    expect(fuzzyMatch('src/components/ChangesPanel.tsx', 'chpan')).not.toBeNull()
    expect(fuzzyMatch('src/auth.ts', 'ta')).toBeNull()
    expect(fuzzyMatch('src/auth.ts', 'xyz')).toBeNull()
    expect(fuzzyMatch('ab', 'abc')).toBeNull()
  })

  it('ignores case', () => {
    expect(fuzzyMatch('README.md', 'readme')).not.toBeNull()
    expect(fuzzyMatch('readme.md', 'README')).not.toBeNull()
  })

  it('places the characters at word starts in the file name, not the first occurrence', () => {
    const path = 'src/components/ChangesPanel.tsx'
    const match = fuzzyMatch(path, 'chpan')
    expect(match?.positions.map((i) => path.charAt(i)).join('')).toBe('ChPan')
    expect(match?.positions[0]).toBe(path.indexOf('ChangesPanel'))
  })

  it('matches nothing for an empty query, with no positions', () => {
    expect(fuzzyMatch('src/auth.ts', '')).toEqual({ path: 'src/auth.ts', score: 0, positions: [] })
  })
})

describe('rankFiles', () => {
  it('puts a match in the file name ahead of one spread over folders', () => {
    const files = ['src/core/repo/git.ts', 'src/renderer/src/components/GitPanel.tsx', 'docs/git.md']
    expect(rankFiles(files, 'git', 10).map((m) => m.path)).toEqual(['docs/git.md', 'src/core/repo/git.ts', 'src/renderer/src/components/GitPanel.tsx'])
  })

  it('ranks word starts and runs over scattered characters', () => {
    const files = ['src/schedule/catchup.ts', 'src/components/ChangesPanel.tsx']
    expect(rankFiles(files, 'chpan', 10)[0]?.path).toBe('src/components/ChangesPanel.tsx')
  })

  it('leaves out files that do not match and stops at the limit', () => {
    const files = ['a.ts', 'ab.ts', 'abc.ts', 'zzz.ts']
    expect(rankFiles(files, 'a', 2)).toHaveLength(2)
    expect(rankFiles(files, 'abc', 10).map((m) => m.path)).toEqual(['abc.ts'])
  })

  it('returns nothing for an empty file list or a blank query', () => {
    expect(rankFiles([], 'a', 10)).toEqual([])
    expect(rankFiles(['a.ts'], '   ', 10)).toEqual([])
  })

  it('needs every space-separated word to match, and marks each word\'s characters', () => {
    const files = ['src/auth/login.ts', 'src/components/AuthPanel.tsx', 'src/panel.ts']
    const ranked = rankFiles(files, 'auth panel', 10)
    expect(ranked.map((m) => m.path)).toEqual(['src/components/AuthPanel.tsx'])
    const marked = ranked[0]?.positions.map((i) => ranked[0]?.path.charAt(i)).join('')
    expect(marked).toBe('AuthPanel')
  })
})

describe('withRecentFirst', () => {
  it('puts matching recent files first in the order they were opened, without repeating them', () => {
    const ranked = rankFiles(['src/a.ts', 'src/ab.ts', 'src/abc.ts'], 'a', 10)
    expect(withRecentFirst({ ranked, recent: ['src/abc.ts', 'README.md', 'src/ab.ts'] }).map((m) => m.path)).toEqual(['src/abc.ts', 'src/ab.ts', 'src/a.ts'])
  })

  it('leaves the order alone with no recent files', () => {
    const ranked = rankFiles(['src/a.ts', 'src/ab.ts'], 'a', 10)
    expect(withRecentFirst({ ranked, recent: [] })).toEqual(ranked)
  })
})

describe('parseQuickOpen', () => {
  it('splits off a line number', () => {
    expect(parseQuickOpen('auth.ts:42')).toEqual({ query: 'auth.ts', line: 42 })
  })

  it('keeps text without a line as the query', () => {
    expect(parseQuickOpen(' auth ')).toEqual({ query: 'auth', line: undefined })
    expect(parseQuickOpen('auth.ts:')).toEqual({ query: 'auth.ts:', line: undefined })
  })

  it('treats a bare line number as a query', () => {
    expect(parseQuickOpen(':42')).toEqual({ query: ':42', line: undefined })
  })
})
