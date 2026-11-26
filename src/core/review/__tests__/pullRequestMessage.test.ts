import { describe, expect, it } from 'vitest'
import type { PullRequestComment } from '../../../shared/ipc'
import { formatPullRequestMessage } from '../pullRequestMessage'

const PR = { number: 7, title: 'Add login', url: 'https://github.com/o/r/pull/7' }

const base = (fields: Partial<PullRequestComment> & Pick<PullRequestComment, 'id' | 'kind' | 'author' | 'body'>): PullRequestComment => ({
  url: `https://github.com/o/r/pull/7#${fields.id}`,
  createdAt: '2026-10-20T10:00:00Z',
  path: null,
  line: null,
  side: null,
  hunk: null,
  resolved: false,
  outdated: false,
  replies: [],
  verdict: null,
  ...fields
})

const thread = base({
  id: 't1',
  kind: 'thread',
  author: 'alice',
  body: 'Handle the error',
  path: 'src/a.ts',
  line: 12,
  side: 'new',
  hunk: '@@ -10,2 +10,3 @@\n const a = 1\n+const b = 2',
  replies: [{ author: 'bob', body: 'Agreed', createdAt: '2026-10-20T11:00:00Z' }]
})

describe('formatPullRequestMessage', () => {
  it('puts the template first and numbers threads, conversation comments and reviews', () => {
    const comments = [
      thread,
      base({ id: 'c1', kind: 'comment', author: 'carol', body: 'Split this PR?' }),
      base({ id: 'r1', kind: 'review', author: 'dave', body: 'Needs tests', verdict: 'changes requested' })
    ]
    expect(formatPullRequestMessage('Analyse these.', PR, comments, 'login')).toBe(
      [
        'Analyse these.',
        'Comments on PR #7 "Add login" (https://github.com/o/r/pull/7), for your changes in login:',
        '1. @alice on src/a.ts:12 (https://github.com/o/r/pull/7#t1)\n```diff\n@@ -10,2 +10,3 @@\n const a = 1\n+const b = 2\n```\nHandle the error\n\n@bob replied: Agreed',
        '2. @carol commented (https://github.com/o/r/pull/7#c1)\nSplit this PR?',
        '3. @dave reviewed, changes requested (https://github.com/o/r/pull/7#r1)\nNeeds tests'
      ].join('\n\n')
    )
  })

  it('marks old-side and outdated threads, and leaves out a missing line', () => {
    const oldSide: PullRequestComment = { ...thread, replies: [], side: 'old' }
    const comments = [oldSide, { ...thread, id: 't2', url: 'https://github.com/o/r/pull/7#t2', replies: [], line: null, outdated: true }]
    const message = formatPullRequestMessage('T', PR, comments, 'login')
    expect(message).toContain('1. @alice on src/a.ts:12 (old side) (https://github.com/o/r/pull/7#t1)')
    expect(message).toContain('2. @alice on src/a.ts (outdated) (https://github.com/o/r/pull/7#t2)')
  })

  it('fences a hunk that contains backticks', () => {
    const message = formatPullRequestMessage('T', PR, [{ ...thread, replies: [], hunk: '+const s = ```' }], 'login')
    expect(message).toContain('````diff\n+const s = ```\n````')
  })
})
