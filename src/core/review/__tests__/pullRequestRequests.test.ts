import { describe, expect, it } from 'vitest'
import type { ReviewComment } from '../../../shared/ipc'
import { reviewProblem, reviewRequest, singleCommentRequest } from '../pullRequestRequests'

const pending = (fields: Partial<ReviewComment>): ReviewComment => ({
  id: 'rc_1',
  relPath: 'src/a.ts',
  diff: 'pr:7',
  side: 'new',
  line: 3,
  lineText: 'x',
  hunk: '+x',
  body: 'Rename this',
  createdAt: 'now',
  sent: null,
  ...fields
})

describe('singleCommentRequest', () => {
  it('builds a single comment body with the head commit and GitHub side names', () => {
    expect(singleCommentRequest({ commitId: 'abc', relPath: 'src/a.ts', side: 'new', line: 3, body: 'Rename' })).toEqual({
      body: 'Rename',
      commit_id: 'abc',
      path: 'src/a.ts',
      line: 3,
      side: 'RIGHT'
    })
    expect(singleCommentRequest({ commitId: 'abc', relPath: 'src/a.ts', side: 'old', line: 9, body: 'Why?' })).toEqual({
      body: 'Why?',
      commit_id: 'abc',
      path: 'src/a.ts',
      line: 9,
      side: 'LEFT'
    })
  })
})

describe('reviewRequest', () => {
  it('builds a review body with every pending comment', () => {
    const comments = [pending({}), pending({ id: 'rc_2', relPath: 'b.ts', side: 'old', line: 1, body: 'Gone?' })]
    expect(reviewRequest({ commitId: 'abc', event: 'REQUEST_CHANGES', body: 'See inline', comments })).toEqual({
      commit_id: 'abc',
      event: 'REQUEST_CHANGES',
      body: 'See inline',
      comments: [
        { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Rename this' },
        { path: 'b.ts', line: 1, side: 'LEFT', body: 'Gone?' }
      ]
    })
  })
})

describe('reviewProblem', () => {
  it('refuses own-PR verdicts, empty change requests and empty comment reviews, in that order', () => {
    expect(reviewProblem({ event: 'APPROVE', body: '', count: 0, own: true })).toBe("You can't approve or request changes on your own PR")
    expect(reviewProblem({ event: 'REQUEST_CHANGES', body: '', count: 2, own: true })).toBe("You can't approve or request changes on your own PR")
    expect(reviewProblem({ event: 'REQUEST_CHANGES', body: '  ', count: 2, own: false })).toBe('Say what needs to change')
    expect(reviewProblem({ event: 'COMMENT', body: '', count: 0, own: false })).toBe('Write a summary or add a comment')
    expect(reviewProblem({ event: 'COMMENT', body: '', count: 1, own: true })).toBeNull()
    expect(reviewProblem({ event: 'APPROVE', body: '', count: 0, own: false })).toBeNull()
  })
})
