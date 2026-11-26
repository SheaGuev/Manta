import { describe, expect, it } from 'vitest'
import type { ReviewComment } from '../../../shared/ipc'
import { formatReviewMessage } from '../reviewMessage'

const BASE: ReviewComment = {
  id: 'rc_000000000001',
  relPath: 'src/login/Login.tsx',
  diff: 'branch',
  side: 'new',
  line: 41,
  lineText: 'const result = await login(email, password)',
  hunk: '- await login(email, password)\n+ const result = await login(email, password)',
  body: 'This swallows the network error. Can we surface it?',
  createdAt: '2026-10-28T00:00:00.000Z',
  sent: null
}

describe('formatReviewMessage', () => {
  it('numbers comments with their place, hunk and body', () => {
    const removed: ReviewComment = { ...BASE, id: 'rc_000000000002', relPath: 'src/a.ts', side: 'old', line: 7, hunk: ' x\n-y', body: 'Keep this.\nIt is used.' }
    expect(formatReviewMessage([BASE, removed], 'wt-alpha')).toBe(
      [
        'Review comments on your changes in wt-alpha:',
        '',
        '1. src/login/Login.tsx:41',
        '```diff',
        '- await login(email, password)',
        '+ const result = await login(email, password)',
        '```',
        'This swallows the network error. Can we surface it?',
        '',
        '2. src/a.ts:7 (old side, removed line)',
        '```diff',
        ' x',
        '-y',
        '```',
        'Keep this.',
        'It is used.'
      ].join('\n')
    )
  })

  it('fences a hunk that contains backticks', () => {
    const message = formatReviewMessage([{ ...BASE, hunk: '+const s = ```' }], 'wt')
    expect(message).toContain('````diff\n+const s = ```\n````')
  })
})
